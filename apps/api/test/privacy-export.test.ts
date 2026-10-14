import { UserDataExport } from "@dit/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claim, login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

/** 隱私權政策第 11 條：在設定頁下載自己的資料（製給複製本） */
describe.skipIf(!pgAvailable)("personal data export (real PostgreSQL)", () => {
  let t: TestContext;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    t = await setupTestApp();
    alice = await login(t, "export-alice", { ip: "203.0.113.24" });
    bob = await login(t, "export-bob", { ip: "198.51.100.9" });
    await t.deps
      .sql`update users set email = 'alice@example.com' where github_login = 'export-alice'`;
    await t.deps
      .sql`update users set email = 'bob-secret@example.com' where github_login = 'export-bob'`;
    await claim(t, alice, "export-a");
    await claim(t, bob, "export-b");
    await request(t, "POST", "/api/v1/subdomains/export-a/records", {
      cookie: alice,
      ip: "203.0.113.24",
      body: { type: "TXT", name: "_hello", ttl: 300, value: "hi" },
    });
    await request(t, "POST", "/api/v1/subdomains/export-b/records", {
      cookie: bob,
      body: { type: "TXT", name: "_bob", ttl: 300, value: "bob-only" },
    });
    const transfer = await request(t, "POST", "/api/v1/subdomains/export-a/transfer", {
      cookie: alice,
      body: { toGithubLogin: "export-bob", keepRecords: true },
    });
    expect(transfer.status).toBe(201);
    await request(t, "POST", "/api/v1/reports", {
      cookie: alice,
      body: {
        subdomain: "someone-else",
        category: "spam",
        details: "這個子網域在寄送大量垃圾郵件",
        contactEmail: "alice@example.com",
        turnstileToken: "pass",
      },
    });
  });
  afterAll(() => t.close());

  it("returns only the requester's own data as a downloadable JSON file", async () => {
    const res = await request(t, "GET", "/api/v1/me/export", { cookie: alice });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="dev-in-tw-export-alice-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = UserDataExport.parse(await res.json());

    expect(data.account).toMatchObject({ githubLogin: "export-alice", email: "alice@example.com" });
    expect(data.subdomains.map((s) => s.name)).toEqual(["export-a"]);
    expect(data.records.map((r) => [r.subdomain, r.name])).toEqual([["export-a", "_hello"]]);
    expect(data.sessions.length).toBeGreaterThanOrEqual(1);
    expect(data.sessions[0]?.ip).toBe("203.0.113.24");
    expect(data.consents.map((c) => c.context)).toContain("login");
    expect(data.transfers).toEqual([
      expect.objectContaining({
        subdomain: "export-a",
        direction: "outgoing",
        counterpart: "export-bob",
        status: "pending",
      }),
    ]);
    expect(data.reports).toEqual([
      expect.objectContaining({ subdomain: "someone-else", contactEmail: "alice@example.com" }),
    ]);
    const actions = data.activity.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.login", "subdomain.create"]));
    expect(data.activity.find((a) => a.action === "auth.login")?.ip).toBe("203.0.113.24");

    // 不含其他使用者的個資與任何機密
    const text = JSON.stringify(data);
    expect(text).not.toContain("bob-secret@example.com");
    expect(text).not.toContain("198.51.100.9");
    expect(text).not.toContain("bob-only");
    expect(text).not.toContain("export-b.");
    const [session] = await t.deps.sql`
      select s.id from sessions s join users u on u.id = s.user_id where u.github_login = 'export-alice'`;
    expect(text).not.toContain(session?.id as string); // token 的雜湊
    expect(text).not.toMatch(/reporter_ip_hash|reporterIpHash|resolutionNote/);
  });

  it("writes an audit entry for every export", async () => {
    const rows = await t.deps.sql`
      select actor_type from audit_logs where action = 'user.export' and target_label = 'export-alice'`;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("is limited to three exports per user per hour", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await request(t, "GET", "/api/v1/me/export", { cookie: bob })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    // 換 IP 也一樣（以使用者計算）
    const other = await request(t, "GET", "/api/v1/me/export", { cookie: bob, ip: "192.0.2.1" });
    expect(other.status).toBe(429);
    t.clock.advance(3600_000);
    expect((await request(t, "GET", "/api/v1/me/export", { cookie: bob })).status).toBe(200);
  });

  it("requires a session", async () => {
    expect((await request(t, "GET", "/api/v1/me/export")).status).toBe(401);
  });
});
