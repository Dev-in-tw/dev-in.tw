import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAY } from "../src/lib/clock.ts";
import { runHousekeeping } from "../src/modules/housekeeping.ts";
import { REPORT_RETENTION_DAYS, redactClosedReports } from "../src/modules/moderation/retention.ts";
import { login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

/** 隱私權政策第 8 條：檢舉處理完成滿 1 年後，清除聯絡 email、IP 雜湊、說明內容與檢舉人關聯 */
describe.skipIf(!pgAvailable)("report retention (real PostgreSQL)", () => {
  let t: TestContext;
  let admin: string;
  let reporter: string;

  const file = async (subdomain: string, opts: { cookie?: string; email?: string } = {}) => {
    const res = await request(t, "POST", "/api/v1/reports", {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ip: "198.51.100.77",
      body: {
        subdomain,
        category: "phishing",
        details: "這個網站假冒銀行登入頁面，要求輸入網銀帳號密碼",
        ...(opts.email ? { contactEmail: opts.email } : {}),
        turnstileToken: "pass",
      },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const resolve = async (id: string, status: "actioned" | "dismissed") => {
    const res = await request(t, "PATCH", `/api/v1/admin/reports/${id}`, {
      cookie: admin,
      body: { status, resolutionNote: "已處理", suspendSubdomain: false },
    });
    expect(res.status).toBe(200);
  };
  const row = async (id: string) => (await t.deps.sql`select * from reports where id = ${id}`)[0];

  beforeAll(async () => {
    t = await setupTestApp();
    admin = await login(t, "HACO8888", { role: "admin" });
    reporter = await login(t, "reporter-1");
  });
  afterAll(() => t.close());

  it("uses a 365-day retention period", () => {
    expect(REPORT_RETENTION_DAYS).toBe(365);
  });

  it("does not keep the reporter's raw IP in the audit log", async () => {
    const id = await file("raw-ip-check", { email: "someone@example.com" });
    const [audit] = await t.deps
      .sql`select ip, metadata from audit_logs where action = 'report.create' and target_id = ${id}`;
    expect(audit?.ip).toBeNull();
    expect(JSON.stringify(audit?.metadata)).not.toContain("someone@example.com");
    expect((await row(id))?.reporter_ip_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("redacts closed reports once they pass the retention period, and only those", async () => {
    const closed = await file("old-phish", { email: "witness@example.com", cookie: reporter });
    const dismissed = await file("old-spam", { email: "other@example.com" });
    const open = await file("still-open", { email: "waiting@example.com" });
    await resolve(closed, "actioned");
    await resolve(dismissed, "dismissed");

    t.clock.advance((REPORT_RETENTION_DAYS - 1) * DAY);
    expect(await redactClosedReports(t.deps)).toBe(0);
    expect((await row(closed))?.contact_email).toBe("witness@example.com");

    t.clock.advance(2 * DAY);
    const result = await runHousekeeping(t.deps);
    expect(result.reportsRedacted).toBeGreaterThanOrEqual(2);

    for (const id of [closed, dismissed]) {
      expect(await row(id)).toMatchObject({
        contact_email: null,
        reporter_ip_hash: null,
        reporter_user_id: null,
        details: "",
      });
      expect((await row(id))?.redacted_at).not.toBeNull();
    }
    // 保留子網域名稱、類別、處理結果與時間
    expect(await row(closed)).toMatchObject({
      subdomain_name: "old-phish",
      category: "phishing",
      status: "actioned",
      resolution_note: "已處理",
    });
    // 還沒結案的檢舉不動
    expect(await row(open)).toMatchObject({
      contact_email: "waiting@example.com",
      redacted_at: null,
    });
    expect((await row(open))?.reporter_ip_hash).not.toBeNull();

    // 已清除的不會重複處理
    expect(await redactClosedReports(t.deps)).toBe(0);

    admin = await login(t, "HACO8888", { role: "admin" }); // 一年前的 session 早就過期了
    const list = await request(t, "GET", "/api/v1/admin/reports?limit=50", { cookie: admin });
    const items = ((await list.json()) as { items: Record<string, unknown>[] }).items;
    const shown = items.find((r) => r.id === closed);
    expect(shown).toMatchObject({ details: "", contactEmail: null, reporter: null });
    expect(typeof shown?.redactedAt).toBe("string");
    expect(items.find((r) => r.id === open)?.redactedAt).toBeNull();
  });
});
