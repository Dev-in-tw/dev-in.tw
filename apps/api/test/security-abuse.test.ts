import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcile } from "../src/sync/reconciler.ts";
import { claim, login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

/** 2026-10 安全稽核（docs/security/AUDIT-2026-10.md）的回歸測試：轉移限流、系統名稱與 DNS 目標 */

describe.skipIf(!pgAvailable)("abuse controls", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(() => t.close());

  describe("abuse controls", () => {
    it("rate limits transfer invitations per user", async () => {
      const cookie = await login(t, "xfer-spammer");
      await login(t, "xfer-target");
      await claim(t, cookie, "xfer-spammer");
      let limited = false;
      for (let i = 0; i < 25 && !limited; i++) {
        const res = await request(t, "POST", "/api/v1/subdomains/xfer-spammer/transfer", {
          cookie,
          body: { toGithubLogin: "xfer-target", keepRecords: false },
        });
        if (res.status === 429) limited = true;
        else if (res.status === 201) {
          const transfer = (await res.json()) as { id: string };
          await request(t, "POST", `/api/v1/transfers/${transfer.id}/cancel`, { cookie });
        }
      }
      expect(limited).toBe(true);
    });

    it("keeps SYSTEM_RECORD_NAMES unavailable even if an admin removes them from the reserved list", async () => {
      const admin = await login(t, "sys-admin", { role: "admin" });
      const removed = await request(t, "DELETE", "/api/v1/admin/reserved-names/mail", {
        cookie: admin,
      });
      expect(removed.status).toBe(204);
      const res = await request(t, "GET", "/api/v1/availability/mail");
      expect(await res.json()).toMatchObject({ status: "reserved" });
      const suggestions = (await (await request(t, "GET", "/api/v1/availability/www")).json()) as {
        suggestions: string[];
      };
      expect(suggestions.suggestions).not.toContain("www");
    });

    it("rejects records that point at internal-only names or use punycode labels", async () => {
      const cookie = await login(t, "dns-guard");
      await claim(t, cookie, "dns-guard");
      const internal = await request(t, "POST", "/api/v1/subdomains/dns-guard/records", {
        cookie,
        body: { type: "CNAME", name: "www", ttl: 1, target: "metadata.google.internal" },
      });
      expect(internal.status).toBe(400);
      expect(await internal.json()).toMatchObject({ code: "RECORD_TARGET_NOT_ALLOWED" });
      const puny = await request(t, "POST", "/api/v1/subdomains/dns-guard/records", {
        cookie,
        body: { type: "A", name: "xn--pypal-4ve", ttl: 1, address: "1.1.1.1" },
      });
      expect(puny.status).toBe(400);
      expect(await puny.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    });
  });
});

describe.skipIf(!pgAvailable)("zone names added after startup", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(() => t.close());

  it("become reserved at the next reconcile instead of waiting for a restart", async () => {
    expect(await (await request(t, "GET", "/api/v1/availability/ops-board")).json()).toMatchObject({
      status: "available",
    });
    // 管理員在 Cloudflare 手動新增的紀錄（沒有 dit: 標記）
    t.provider.seed({
      fqdn: "ops-board.dev-in.tw",
      type: "CNAME",
      ttl: 1,
      content: "status.example.net",
      comment: null,
    });
    await reconcile(t.deps);
    expect(await (await request(t, "GET", "/api/v1/availability/ops-board")).json()).toMatchObject({
      status: "reserved",
    });
  });
});
