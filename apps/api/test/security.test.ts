import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sanitizeRedirect } from "../src/modules/identity/github-oauth.ts";
import { claim, login, ORIGIN, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "";

describe("sanitizeRedirect (open redirect guard)", () => {
  it.each([
    ["/dashboard/alice", "/dashboard/alice"],
    ["/claim/alice?x=1", "/claim/alice?x=1"],
    ["//evil.com", "/dashboard"],
    ["/\\evil.com", "/dashboard"],
    ["https://evil.com", "/dashboard"],
    ["javascript:alert(1)", "/dashboard"],
    ["/%0d%0aSet-Cookie:x", "/%0d%0aSet-Cookie:x"],
    ["/foo\nbar", "/dashboard"],
    [`/${"a".repeat(220)}`, "/dashboard"],
    ["", "/dashboard"],
    [undefined, "/dashboard"],
  ])("%s → %s", (input, expected) => {
    expect(sanitizeRedirect(input)).toBe(expected);
  });
});

describe.skipIf(!pgAvailable)("security", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(() => t.close());

  describe("CSRF", () => {
    let cookie: string;
    beforeAll(async () => {
      cookie = await login(t, "csrf-user");
    });
    const body = { displayName: "x" };

    it("rejects a write without Origin", async () => {
      const res = await request(t, "PATCH", "/api/v1/me", { cookie, body, origin: null });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "CSRF_REJECTED" });
    });

    it("rejects a write from another origin, including a user subdomain", async () => {
      for (const origin of [
        "https://evil.example",
        "https://alice.dev-in.tw",
        "http://dev-in.tw",
      ]) {
        const res = await request(t, "PATCH", "/api/v1/me", { cookie, body, origin });
        expect(res.status).toBe(403);
      }
    });

    it("rejects Sec-Fetch-Site: same-site and cross-site even with the right Origin", async () => {
      for (const site of ["same-site", "cross-site", "none"]) {
        const res = await request(t, "PATCH", "/api/v1/me", { cookie, body, secFetchSite: site });
        expect(res.status).toBe(403);
      }
    });

    it("rejects form-encoded bodies (simple requests)", async () => {
      const res = await request(t, "PATCH", "/api/v1/me", {
        cookie,
        rawBody: "displayName=x",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      expect(res.status).toBe(403);
      const plain = await request(t, "POST", "/api/v1/auth/logout", {
        cookie,
        rawBody: "{}",
        headers: { "Content-Type": "text/plain" },
      });
      expect(plain.status).toBe(403);
    });

    it("accepts a same-origin JSON write (Sec-Fetch-Site optional)", async () => {
      expect((await request(t, "PATCH", "/api/v1/me", { cookie, body })).status).toBe(200);
      expect(
        (await request(t, "PATCH", "/api/v1/me", { cookie, body, secFetchSite: null })).status,
      ).toBe(200);
    });

    it("does not apply to safe methods", async () => {
      const res = await request(t, "GET", "/api/v1/me", {
        cookie,
        origin: "https://evil.example",
        secFetchSite: "cross-site",
      });
      expect(res.status).toBe(200);
    });
  });

  describe("session cookie", () => {
    it("uses __Host- with HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain", async () => {
      const res = await request(t, "POST", "/api/v1/auth/dev-login", {
        body: { githubLogin: "cookie-user" },
      });
      const cookie = cookieOf(res, "__Host-dit_session");
      const attrs = cookie.split(";").map((p) => p.trim().toLowerCase());
      expect(cookie.startsWith("__Host-dit_session=")).toBe(true);
      expect(attrs).toEqual(
        expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/"]),
      );
      expect(attrs.some((a) => a.startsWith("domain"))).toBe(false);
      expect(attrs).toContain(`max-age=${60 * 24 * 3600}`);
    });

    it("stores only the token hash and ignores malformed or unknown tokens", async () => {
      const cookie = await login(t, "hash-user");
      const token = cookie.split("=")[1] as string;
      const rows = await t.deps.sql`select id from sessions where id = ${token}`;
      expect(rows).toHaveLength(0);
      expect(
        (await request(t, "GET", "/api/v1/me", { cookie: "__Host-dit_session=garbage" })).status,
      ).toBe(401);
      expect(
        (await request(t, "GET", "/api/v1/me", { cookie: `__Host-dit_session=${"A".repeat(43)}` }))
          .status,
      ).toBe(401);
    });

    it("expires after 14 idle days and slides while in use", async () => {
      const cookie = await login(t, "idle-user");
      t.clock.advance(13 * 86_400_000);
      expect((await request(t, "GET", "/api/v1/me", { cookie })).status).toBe(200);
      t.clock.advance(13 * 86_400_000);
      expect((await request(t, "GET", "/api/v1/me", { cookie })).status).toBe(200);
      t.clock.advance(15 * 86_400_000);
      expect((await request(t, "GET", "/api/v1/me", { cookie })).status).toBe(401);
    });

    it("expires at the 60-day absolute limit even when active", async () => {
      const cookie = await login(t, "absolute-user");
      for (let i = 0; i < 5; i++) {
        t.clock.advance(10 * 86_400_000);
        expect((await request(t, "GET", "/api/v1/me", { cookie })).status).toBe(200);
      }
      t.clock.advance(9 * 86_400_000);
      expect((await request(t, "GET", "/api/v1/me", { cookie })).status).toBe(200);
      t.clock.advance(2 * 86_400_000);
      expect((await request(t, "GET", "/api/v1/me", { cookie })).status).toBe(401);
    });

    it("logout revokes the session server-side and clears the cookie", async () => {
      const cookie = await login(t, "logout-user");
      const res = await request(t, "POST", "/api/v1/auth/logout", { cookie });
      expect(res.status).toBe(204);
      expect(cookieOf(res, "__Host-dit_session")).toContain("Max-Age=0");
      expect((await request(t, "GET", "/api/v1/me", { cookie })).status).toBe(401);
    });
  });

  describe("GitHub OAuth", () => {
    const start = async (redirect?: string) => {
      const res = await request(
        t,
        "GET",
        `/api/v1/auth/github/start${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ""}`,
      );
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") as string);
      const oauthCookie = cookieOf(res, "__Host-dit_oauth").split(";")[0] as string;
      return { location, oauthCookie };
    };

    it("starts with state and PKCE S256, scope user:email, and a __Host- state cookie", async () => {
      const { location, oauthCookie } = await start("/claim/alice");
      expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(location.searchParams.get("scope")).toBe("user:email");
      expect(location.searchParams.get("redirect_uri")).toBe(
        `${ORIGIN}/api/v1/auth/github/callback`,
      );
      expect(oauthCookie.startsWith("__Host-dit_oauth=")).toBe(true);
    });

    it("completes a login, upserts by GitHub id, sets admin from ADMIN_GITHUB_IDS and redirects", async () => {
      t.github.identities.set("good-code", {
        id: 51485352,
        login: "HACO8888",
        name: "Haco",
        avatarUrl: "https://avatars.githubusercontent.com/u/51485352?v=4",
        createdAt: new Date("2019-05-01T00:00:00Z"),
        email: "haco@example.com",
      });
      const { location, oauthCookie } = await start("/admin");
      const state = location.searchParams.get("state") as string;
      const res = await request(
        t,
        "GET",
        `/api/v1/auth/github/callback?code=good-code&state=${state}`,
        { cookie: oauthCookie },
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/admin`);
      expect(cookieOf(res, "__Host-dit_oauth")).toContain("Max-Age=0");
      const session = cookieOf(res, "__Host-dit_session").split(";")[0] as string;
      const me = await request(t, "GET", "/api/v1/me", { cookie: session });
      expect(await me.json()).toMatchObject({
        githubId: 51485352,
        role: "admin",
        email: "haco@example.com",
      });
      // PKCE verifier 送給 GitHub，且與 challenge 對應
      const call = t.github.calls.at(-1);
      expect(call?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it("rejects a mismatched, missing or expired state", async () => {
      const { oauthCookie } = await start();
      const mismatch = await request(
        t,
        "GET",
        "/api/v1/auth/github/callback?code=good-code&state=attacker",
        { cookie: oauthCookie },
      );
      expect(mismatch.headers.get("location")).toBe(`${ORIGIN}/login?error=state_mismatch`);
      expect(cookieOf(mismatch, "__Host-dit_session")).toBe("");

      const noCookie = await request(
        t,
        "GET",
        "/api/v1/auth/github/callback?code=good-code&state=x",
      );
      expect(noCookie.headers.get("location")).toBe(`${ORIGIN}/login?error=state_mismatch`);

      const fresh = await start();
      const state = fresh.location.searchParams.get("state") as string;
      t.clock.advance(11 * 60_000);
      const expired = await request(
        t,
        "GET",
        `/api/v1/auth/github/callback?code=good-code&state=${state}`,
        { cookie: fresh.oauthCookie },
      );
      expect(expired.headers.get("location")).toBe(`${ORIGIN}/login?error=state_mismatch`);

      const tampered = `${fresh.oauthCookie.slice(0, -4)}AAAA`;
      const forged = await request(
        t,
        "GET",
        `/api/v1/auth/github/callback?code=good-code&state=${state}`,
        { cookie: tampered },
      );
      expect(forged.headers.get("location")).toBe(`${ORIGIN}/login?error=state_mismatch`);
    });

    it("maps a denied consent or a failed exchange to oauth_failed", async () => {
      const a = await start();
      const denied = await request(
        t,
        "GET",
        `/api/v1/auth/github/callback?error=access_denied&state=${a.location.searchParams.get("state")}`,
        { cookie: a.oauthCookie },
      );
      expect(denied.headers.get("location")).toBe(`${ORIGIN}/login?error=oauth_failed`);
      const b = await start();
      const bad = await request(
        t,
        "GET",
        `/api/v1/auth/github/callback?code=unknown&state=${b.location.searchParams.get("state")}`,
        { cookie: b.oauthCookie },
      );
      expect(bad.headers.get("location")).toBe(`${ORIGIN}/login?error=oauth_failed`);
    });

    it("refuses suspended accounts", async () => {
      t.github.identities.set("suspended-code", {
        id: 777,
        login: "banned",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/777",
        createdAt: new Date("2018-01-01T00:00:00Z"),
        email: null,
      });
      const a = await start();
      await request(
        t,
        "GET",
        `/api/v1/auth/github/callback?code=suspended-code&state=${a.location.searchParams.get("state")}`,
        { cookie: a.oauthCookie },
      );
      await t.deps.sql`update users set status = 'suspended' where github_id = 777`;
      const b = await start();
      const res = await request(
        t,
        "GET",
        `/api/v1/auth/github/callback?code=suspended-code&state=${b.location.searchParams.get("state")}`,
        { cookie: b.oauthCookie },
      );
      expect(res.headers.get("location")).toBe(`${ORIGIN}/login?error=suspended`);
      expect(cookieOf(res, "__Host-dit_session")).toBe("");
    });

    it("dev login is a 404 when disabled", async () => {
      const off = await setupTestApp({ env: { AUTH_DEV_LOGIN: "false" } });
      try {
        const res = await request(off, "POST", "/api/v1/auth/dev-login", {
          body: { githubLogin: "x" },
        });
        expect(res.status).toBe(404);
      } finally {
        await off.close();
      }
    });
  });

  describe("authorization", () => {
    let alice: string;
    let mallory: string;
    let recordId: string;
    beforeAll(async () => {
      alice = await login(t, "idor-alice");
      mallory = await login(t, "idor-mallory");
      await claim(t, alice, "idor-alice");
      await claim(t, mallory, "idor-mallory");
      const res = await request(t, "POST", "/api/v1/subdomains/idor-alice/records", {
        cookie: alice,
        body: { type: "TXT", name: "@", ttl: 1, value: "secret" },
      });
      recordId = ((await res.json()) as { id: string }).id;
    });

    it("answers another user's subdomain and records with 404 (IDOR)", async () => {
      const paths: [string, string, unknown?][] = [
        ["GET", "/api/v1/subdomains/idor-alice"],
        ["GET", "/api/v1/subdomains/idor-alice/records"],
        ["GET", "/api/v1/subdomains/idor-alice/activity"],
        ["PATCH", "/api/v1/subdomains/idor-alice", { description: "pwned" }],
        [
          "POST",
          "/api/v1/subdomains/idor-alice/records",
          { type: "TXT", name: "x", ttl: 1, value: "x" },
        ],
        [
          "PUT",
          `/api/v1/subdomains/idor-alice/records/${recordId}`,
          { type: "TXT", name: "@", ttl: 1, value: "x" },
        ],
        ["DELETE", `/api/v1/subdomains/idor-alice/records/${recordId}`],
        ["POST", "/api/v1/subdomains/idor-alice/release", { confirm: "idor-alice" }],
        ["POST", "/api/v1/subdomains/idor-alice/transfer", { toGithubLogin: "idor-mallory" }],
        // 自己的子網域路徑搭配別人的 record id
        [
          "PUT",
          `/api/v1/subdomains/idor-mallory/records/${recordId}`,
          { type: "TXT", name: "@", ttl: 1, value: "x" },
        ],
        ["DELETE", `/api/v1/subdomains/idor-mallory/records/${recordId}`],
      ];
      for (const [method, path, body] of paths) {
        const res = await request(t, method, path, { cookie: mallory, ...(body ? { body } : {}) });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND");
      }
      const check = await request(t, "GET", "/api/v1/subdomains/idor-alice/records", {
        cookie: alice,
      });
      expect(((await check.json()) as { items: { value: string }[] }).items[0]?.value).toBe(
        "secret",
      );
    });

    it("hides admin endpoints from non-admins and anonymous users with 404", async () => {
      for (const cookie of [mallory, undefined]) {
        const res = await request(t, "GET", "/api/v1/admin/overview", cookie ? { cookie } : {});
        expect(res.status).toBe(404);
      }
      const res = await request(t, "POST", "/api/v1/admin/zone/reconcile?force=true", {
        cookie: mallory,
      });
      expect(res.status).toBe(404);
    });

    it("requires a session for user endpoints", async () => {
      expect((await request(t, "GET", "/api/v1/subdomains")).status).toBe(401);
    });

    it("invalidates a suspended user's sessions immediately", async () => {
      const admin = await login(t, "sec-admin", { role: "admin" });
      const victim = await login(t, "sec-victim");
      await claim(t, victim, "sec-victim");
      const me = (await (await request(t, "GET", "/api/v1/me", { cookie: victim })).json()) as {
        id: string;
      };
      const res = await request(t, "PATCH", `/api/v1/admin/users/${me.id}`, {
        cookie: admin,
        body: { status: "suspended", reason: "abuse" },
      });
      expect(res.status).toBe(200);
      expect((await request(t, "GET", "/api/v1/me", { cookie: victim })).status).toBe(401);
      const sub = await t.deps
        .sql`select status, suspended_by_user from subdomains where name = 'sec-victim'`;
      expect(sub[0]).toMatchObject({ status: "suspended", suspended_by_user: true });
      // 一個仍然有效的 session 碰到停權的帳號：403 ACCOUNT_SUSPENDED（登出仍允許）
      await t.deps.sql`update users set status = 'active' where id = ${me.id}`;
      const again = await login(t, "sec-victim");
      await t.deps.sql`update users set status = 'suspended' where id = ${me.id}`;
      const blocked = await request(t, "GET", "/api/v1/subdomains", { cookie: again });
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toMatchObject({ code: "ACCOUNT_SUSPENDED" });
      expect((await request(t, "POST", "/api/v1/auth/logout", { cookie: again })).status).toBe(204);
      // 管理員不能停權自己
      const adminMe = (await (await request(t, "GET", "/api/v1/me", { cookie: admin })).json()) as {
        id: string;
      };
      const self = await request(t, "PATCH", `/api/v1/admin/users/${adminMe.id}`, {
        cookie: admin,
        body: { status: "suspended" },
      });
      expect(self.status).toBe(400);
    });
  });

  describe("rate limiting", () => {
    it("returns 429 with Retry-After and retryAfter for availability bursts per IP", async () => {
      const ip = "203.0.113.10";
      for (let i = 0; i < 20; i++) {
        expect((await request(t, "GET", `/api/v1/availability/name-${i}`, { ip })).status).toBe(
          200,
        );
      }
      const limited = await request(t, "GET", "/api/v1/availability/one-more", { ip });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await limited.json()).toMatchObject({
        code: "RATE_LIMITED",
        retryAfter: expect.any(Number),
      });
      // 其他 IP 不受影響；時間過後恢復
      expect(
        (await request(t, "GET", "/api/v1/availability/other", { ip: "203.0.113.11" })).status,
      ).toBe(200);
      t.clock.advance(60_000);
      expect((await request(t, "GET", "/api/v1/availability/again", { ip })).status).toBe(200);
    });

    it("cannot be bypassed by forging the leftmost X-Forwarded-For entry (TRUSTED_PROXY_HOPS=1)", async () => {
      for (let i = 0; i < 25; i++) {
        await request(t, "GET", `/api/v1/availability/spoof-${i}`, {
          headers: { "X-Forwarded-For": `1.2.3.${i}, 203.0.113.20` },
          ip: `1.2.3.${i}, 203.0.113.20`,
        });
      }
      const res = await request(t, "GET", "/api/v1/availability/spoof-final", {
        ip: "9.9.9.9, 203.0.113.20",
      });
      expect(res.status).toBe(429);
    });

    it("ignores a forged CF-Connecting-IP without a Cloudflare proxy (TRUST_CLOUDFLARE=false)", async () => {
      expect(t.config.TRUST_CLOUDFLARE).toBe(false);
      for (let i = 0; i < 25; i++) {
        await request(t, "GET", `/api/v1/availability/cf-${i}`, {
          headers: { "CF-Connecting-IP": `5.6.7.${i}` },
          ip: "203.0.113.30",
        });
      }
      const res = await request(t, "GET", "/api/v1/availability/cf-final", {
        headers: { "CF-Connecting-IP": "5.6.7.200" },
        ip: "203.0.113.30",
      });
      expect(res.status).toBe(429);
    });

    it("limits record writes per user (10 per minute)", async () => {
      const cookie = await login(t, "rl-writer");
      await claim(t, cookie, "rl-writer");
      await t.deps.sql`update users set quota_records = 50 where github_login = 'rl-writer'`;
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await request(t, "POST", "/api/v1/subdomains/rl-writer/records", {
          cookie,
          body: { type: "TXT", name: `t${i}`, ttl: 1, value: `v${i}` },
        });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it("picks the right X-Forwarded-For entry with TRUSTED_PROXY_HOPS=2", async () => {
      const two = await setupTestApp({ env: { TRUSTED_PROXY_HOPS: "2" } });
      try {
        // client, cloudflare-edge, traefik：hops=2 → 從右邊數第 2 個是真正的 client
        for (let i = 0; i < 20; i++) {
          await request(two, "GET", `/api/v1/availability/h2-${i}`, {
            ip: `6.6.6.${i}, 203.0.113.30, 10.0.0.1`,
          });
        }
        const limited = await request(two, "GET", "/api/v1/availability/h2-x", {
          ip: "7.7.7.7, 203.0.113.30, 10.0.0.1",
        });
        expect(limited.status).toBe(429);
        const other = await request(two, "GET", "/api/v1/availability/h2-y", {
          ip: "7.7.7.7, 203.0.113.31, 10.0.0.1",
        });
        expect(other.status).toBe(200);
      } finally {
        await two.close();
      }
    });
  });

  describe("idempotency and optimistic concurrency", () => {
    it("replays the first response for the same Idempotency-Key and rejects reuse with a different body", async () => {
      const cookie = await login(t, "idem-user");
      await claim(t, cookie, "idem-user");
      const body = { type: "TXT", name: "idem", ttl: 1, value: "once" };
      const first = await request(t, "POST", "/api/v1/subdomains/idem-user/records", {
        cookie,
        body,
        headers: { "Idempotency-Key": "key-00000001" },
      });
      const second = await request(t, "POST", "/api/v1/subdomains/idem-user/records", {
        cookie,
        body,
        headers: { "Idempotency-Key": "key-00000001" },
      });
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.headers.get("idempotent-replayed")).toBe("true");
      expect(await second.json()).toEqual(await first.json());
      const count = await t.deps
        .sql`select count(*)::int as n from dns_records r join subdomains s on s.id = r.subdomain_id where s.name = 'idem-user'`;
      expect(count[0]?.n).toBe(1);
      const reused = await request(t, "POST", "/api/v1/subdomains/idem-user/records", {
        cookie,
        body: { ...body, value: "twice" },
        headers: { "Idempotency-Key": "key-00000001" },
      });
      expect(reused.status).toBe(422);
      expect(await reused.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      // 失敗的請求不會佔用 key
      const failed = await request(t, "POST", "/api/v1/subdomains/idem-user/records", {
        cookie,
        body: { type: "A", name: "x", ttl: 1, address: "127.0.0.1" },
        headers: { "Idempotency-Key": "key-00000002" },
      });
      expect(failed.status).toBe(400);
      const retry = await request(t, "POST", "/api/v1/subdomains/idem-user/records", {
        cookie,
        body: { type: "A", name: "x", ttl: 1, address: "1.1.1.1" },
        headers: { "Idempotency-Key": "key-00000002" },
      });
      expect(retry.status).toBe(202);
      const bad = await request(t, "POST", "/api/v1/subdomains/idem-user/records", {
        cookie,
        body,
        headers: { "Idempotency-Key": "short" },
      });
      expect(bad.status).toBe(400);
    });

    it("enforces If-Match on replace and delete", async () => {
      const cookie = await login(t, "ifmatch-user");
      await claim(t, cookie, "ifmatch-user");
      const created = (await (
        await request(t, "POST", "/api/v1/subdomains/ifmatch-user/records", {
          cookie,
          body: { type: "TXT", name: "v", ttl: 1, value: "1" },
        })
      ).json()) as { id: string; version: number };
      const path = `/api/v1/subdomains/ifmatch-user/records/${created.id}`;
      const stale = await request(t, "PUT", path, {
        cookie,
        body: { type: "TXT", name: "v", ttl: 1, value: "2" },
        headers: { "If-Match": '"7"' },
      });
      expect(stale.status).toBe(412);
      const ok = await request(t, "PUT", path, {
        cookie,
        body: { type: "TXT", name: "v", ttl: 1, value: "2" },
        headers: { "If-Match": `"${created.version}"` },
      });
      expect(ok.status).toBe(202);
      expect(((await ok.json()) as { version: number }).version).toBe(created.version + 1);
      const malformed = await request(t, "DELETE", path, {
        cookie,
        headers: { "If-Match": "abc" },
      });
      expect(malformed.status).toBe(400);
      const staleDelete = await request(t, "DELETE", path, {
        cookie,
        headers: { "If-Match": `"${created.version}"` },
      });
      expect(staleDelete.status).toBe(412);
      const del = await request(t, "DELETE", path, {
        cookie,
        headers: { "If-Match": `"${created.version + 1}"` },
      });
      expect(del.status).toBe(202);
      expect(((await del.json()) as { syncStatus: string }).syncStatus).toBe("deleting");
    });
  });

  it("returns problem+json for malformed JSON and invalid bodies", async () => {
    const cookie = await login(t, "json-user");
    const broken = await request(t, "PATCH", "/api/v1/me", {
      cookie,
      rawBody: "{oops",
      headers: { "Content-Type": "application/json" },
    });
    expect(broken.status).toBe(400);
    expect(broken.headers.get("content-type")).toContain("application/problem+json");
    const invalid = await request(t, "POST", "/api/v1/subdomains", {
      cookie,
      body: { name: "x", acceptTerms: false },
    });
    expect(invalid.status).toBe(400);
    const problem = (await invalid.json()) as { code: string; errors: { path: string }[] };
    expect(problem.code).toBe("VALIDATION_FAILED");
    expect(problem.errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(["name", "acceptTerms", "turnstileToken"]),
    );
  });
});
