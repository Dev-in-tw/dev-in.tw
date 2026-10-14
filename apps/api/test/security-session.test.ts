import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCookie } from "../src/http/middleware/core.ts";
import { effectiveRole } from "../src/modules/identity/sessions.ts";
import { login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

/** 2026-10 安全稽核（docs/security/AUDIT-2026-10.md）的回歸測試：角色、cookie 與 session 輪替 */

const cookieOf = (res: Response, name: string): string =>
  (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`)) ?? "";

describe("effective admin role", () => {
  const prod = { ADMIN_GITHUB_IDS: [1], AUTH_DEV_LOGIN: false, NODE_ENV: "production" as const };
  it("demotes admins that are no longer listed in ADMIN_GITHUB_IDS", () => {
    expect(effectiveRole({ role: "admin", githubId: 1 }, prod)).toBe("admin");
    expect(effectiveRole({ role: "admin", githubId: 2 }, prod)).toBe("user");
    expect(effectiveRole({ role: "user", githubId: 1 }, prod)).toBe("user");
  });
  it("keeps dev-login admins outside production only", () => {
    const dev = { ...prod, AUTH_DEV_LOGIN: true, NODE_ENV: "development" as const };
    expect(effectiveRole({ role: "admin", githubId: 2 }, dev)).toBe("admin");
    expect(effectiveRole({ role: "admin", githubId: 2 }, { ...dev, NODE_ENV: "production" })).toBe(
      "user",
    );
  });
});

describe("cookie parsing", () => {
  it("treats a duplicated cookie name as absent (nameless-cookie / tossing guard)", () => {
    expect(readCookie("a=1; __Host-dit_session=abc", "__Host-dit_session")).toBe("abc");
    expect(
      readCookie("__Host-dit_session=evil; __Host-dit_session=abc", "__Host-dit_session"),
    ).toBeUndefined();
    expect(readCookie("__host-dit_session=abc", "__Host-dit_session")).toBeUndefined();
  });
});

describe.skipIf(!pgAvailable)("session hardening", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(() => t.close());

  describe("admin role follows ADMIN_GITHUB_IDS on every request", () => {
    it("removes admin access from an existing session when the id leaves the list", async () => {
      const original = { ...t.deps.config };
      try {
        t.github.identities.set("admin-code", {
          id: 51485352,
          login: "HACO8888",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/51485352?v=4",
          createdAt: new Date("2019-05-01T00:00:00Z"),
          email: null,
        });
        const start = await request(t, "GET", "/api/v1/auth/github/start");
        const state = new URL(start.headers.get("location") as string).searchParams.get("state");
        const oauth = cookieOf(start, "__Host-dit_oauth").split(";")[0] as string;
        const cb = await request(
          t,
          "GET",
          `/api/v1/auth/github/callback?code=admin-code&state=${state}`,
          {
            cookie: oauth,
          },
        );
        const session = cookieOf(cb, "__Host-dit_session").split(";")[0] as string;
        t.deps.config.AUTH_DEV_LOGIN = false;
        expect(
          (await request(t, "GET", "/api/v1/admin/overview", { cookie: session })).status,
        ).toBe(200);
        t.deps.config.ADMIN_GITHUB_IDS = [1];
        expect(
          (await request(t, "GET", "/api/v1/admin/overview", { cookie: session })).status,
        ).toBe(404);
        const me = await request(t, "GET", "/api/v1/me", { cookie: session });
        expect(await me.json()).toMatchObject({ role: "user" });
      } finally {
        t.deps.config.AUTH_DEV_LOGIN = original.AUTH_DEV_LOGIN;
        t.deps.config.ADMIN_GITHUB_IDS = original.ADMIN_GITHUB_IDS;
      }
    });
  });

  describe("session handling", () => {
    it("ignores a request that carries the session cookie twice", async () => {
      const cookie = await login(t, "dup-alice");
      expect((await request(t, "GET", "/api/v1/me", { cookie })).status).toBe(200);
      const res = await request(t, "GET", "/api/v1/me", {
        cookie: `__Host-dit_session=planted-by-a-subdomain-xxxxxxxx; ${cookie}`,
      });
      expect(res.status).toBe(401);
    });

    it("revokes the session the browser already had when a new GitHub login completes", async () => {
      const before = await login(t, "rotate-alice");
      t.github.identities.set("rotate-code", {
        id: 4242,
        login: "rotate-bob",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/4242?v=4",
        createdAt: new Date("2019-05-01T00:00:00Z"),
        email: null,
      });
      const start = await request(t, "GET", "/api/v1/auth/github/start");
      const state = new URL(start.headers.get("location") as string).searchParams.get("state");
      const oauth = cookieOf(start, "__Host-dit_oauth").split(";")[0] as string;
      const cb = await request(
        t,
        "GET",
        `/api/v1/auth/github/callback?code=rotate-code&state=${state}`,
        {
          cookie: `${oauth}; ${before}`,
        },
      );
      expect(cb.status).toBe(303);
      const after = cookieOf(cb, "__Host-dit_session").split(";")[0] as string;
      expect(after).not.toBe(before);
      expect((await request(t, "GET", "/api/v1/me", { cookie: before })).status).toBe(401);
      expect(await (await request(t, "GET", "/api/v1/me", { cookie: after })).json()).toMatchObject(
        { githubLogin: "rotate-bob" },
      );
    });
  });
});
