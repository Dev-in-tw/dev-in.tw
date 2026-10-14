import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StreamSlots } from "../src/http/routes/events.ts";
import { login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

/** 2026-10 安全稽核（docs/security/AUDIT-2026-10.md）的回歸測試：SSE 連線上限與 session 重新驗證 */

describe("SSE slots", () => {
  it("enforces per-user, per-IP and global caps and frees slots exactly once", () => {
    const slots = new StreamSlots({ perUser: 2, perIp: 3, total: 4 });
    const a1 = slots.acquire("a", "ip1");
    const a2 = slots.acquire("a", "ip1");
    expect(a1 && a2).toBeTruthy();
    expect(slots.acquire("a", "ip2")).toBeNull(); // per user
    const b1 = slots.acquire("b", "ip1");
    expect(b1).toBeTruthy();
    expect(slots.acquire("c", "ip1")).toBeNull(); // per IP
    const c1 = slots.acquire("c", "ip2");
    expect(c1).toBeTruthy();
    expect(slots.acquire("d", "ip3")).toBeNull(); // total
    a1?.();
    a1?.(); // 重複 release 不會多還名額
    expect(slots.total).toBe(3);
    expect(slots.acquire("d", "ip3")).toBeTruthy();
    expect(slots.acquire("e", "ip4")).toBeNull();
  });
});

describe.skipIf(!pgAvailable)("event stream hardening", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupTestApp({ app: { sseRevalidateMs: 1000, sseLimits: { perIp: 3 } } });
  });
  afterAll(() => t.close());

  describe("server-sent events", () => {
    async function drainUntilClosed(res: Response, timeoutMs: number): Promise<boolean> {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
        ]);
        if (chunk === null) break;
        if (chunk.done) return true;
      }
      await reader.cancel();
      return false;
    }

    const waitFor = async (check: () => boolean, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      return check();
    };

    it("closes an open stream after the session is logged out", async () => {
      const cookie = await login(t, "sse-logout");
      const stream = await request(t, "GET", "/api/v1/events", { cookie });
      expect(stream.status).toBe(200);
      const closed = drainUntilClosed(stream, 15_000);
      const out = await request(t, "POST", "/api/v1/auth/logout", { cookie });
      expect(out.status).toBe(204);
      expect(await closed).toBe(true);
    }, 30_000);

    it("closes an open stream when an admin suspends the account", async () => {
      const cookie = await login(t, "sse-suspend");
      const admin = await login(t, "sse-admin", { role: "admin" });
      const me = (await (await request(t, "GET", "/api/v1/me", { cookie })).json()) as {
        id: string;
      };
      const stream = await request(t, "GET", "/api/v1/events", { cookie });
      const closed = drainUntilClosed(stream, 15_000);
      const res = await request(t, "PATCH", `/api/v1/admin/users/${me.id}`, {
        cookie: admin,
        body: { status: "suspended", reason: "test" },
      });
      expect(res.status).toBe(200);
      expect(await closed).toBe(true);
    }, 30_000);

    it("caps concurrent streams per user and returns the slots when streams end", async () => {
      const cookie = await login(t, "sse-cap");
      const base = t.app.streams.total;
      const open: Response[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await request(t, "GET", "/api/v1/events", { cookie });
        expect(res.status).toBe(200);
        open.push(res);
      }
      const sixth = await request(t, "GET", "/api/v1/events", { cookie });
      expect(sixth.status).toBe(429);
      expect(sixth.headers.get("retry-after")).toBe("30");
      for (const res of open) await res.body?.cancel();
      expect(await waitFor(() => t.app.streams.total === base)).toBe(true);
      // 開關很多次之後名額不會外洩
      for (let round = 0; round < 3; round++) {
        const res = await request(t, "GET", "/api/v1/events", { cookie });
        expect(res.status).toBe(200);
        await res.body?.cancel();
      }
      expect(await waitFor(() => t.app.streams.total === base)).toBe(true);
      const again = await request(t, "GET", "/api/v1/events", { cookie });
      expect(again.status).toBe(200);
      await again.body?.cancel();
    });

    it("caps concurrent streams per source IP across accounts", async () => {
      const ip = "2001:db8:77:1::10";
      const opened: Response[] = [];
      for (let i = 0; i < 3; i++) {
        const cookie = await login(t, `sse-ip-${i}`);
        // 同一個 /64 內換位址也算同一個來源
        const res = await request(t, "GET", "/api/v1/events", {
          cookie,
          ip: `2001:db8:77:1::${i + 1}`,
        });
        expect(res.status).toBe(200);
        opened.push(res);
      }
      const cookie = await login(t, "sse-ip-x");
      const blocked = await request(t, "GET", "/api/v1/events", { cookie, ip });
      expect(blocked.status).toBe(429);
      for (const res of opened) await res.body?.cancel();
    });
  });
});
