import { AppError } from "../../lib/problem.ts";
import { writeAudit } from "../../modules/audit/service.ts";
import { completeGithubLogin, startGithubLogin } from "../../modules/identity/github-oauth.ts";
import {
  clearCookie,
  createSession,
  OAUTH_COOKIE,
  revokeSessionById,
  SESSION_COOKIE,
  sessionCookie,
} from "../../modules/identity/sessions.ts";
import { devIdentity, upsertGithubUser } from "../../modules/identity/users.ts";
import { define, type Registry } from "../define.ts";
import { readCookie } from "../middleware/core.ts";
import { RULES } from "../middleware/rate-limit.ts";

const redirect = (location: string, status: 302 | 303, cookies: string[] = []) => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
};

export function authRoutes(reg: Registry): void {
  define(
    reg,
    "startGithubLogin",
    async ({ c, query }) => {
      const deps = c.get("deps");
      if (!deps.config.GITHUB_CLIENT_ID) {
        return redirect(`${deps.config.APP_ORIGIN}/login?error=oauth_failed`, 302);
      }
      const start = startGithubLogin(deps, query.redirect);
      return redirect(start.location, 302, [
        `${OAUTH_COOKIE}=${start.cookieValue}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${start.maxAgeSeconds}`,
      ]);
    },
    { rateLimits: [RULES.auth] },
  );

  define(
    reg,
    "githubCallback",
    async ({ c, query }) => {
      const deps = c.get("deps");
      const outcome = await completeGithubLogin(deps, {
        code: query.code,
        state: query.state,
        error: query.error,
        cookie: readCookie(c.req.header("cookie"), OAUTH_COOKIE),
        previousSession: readCookie(c.req.header("cookie"), SESSION_COOKIE),
        ip: c.get("clientIp"),
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId"),
      });
      // state cookie 用完立刻清掉（成功或失敗都一樣）
      const cookies = [clearCookie(OAUTH_COOKIE)];
      if (outcome.ok) {
        cookies.push(sessionCookie(outcome.sessionToken));
        c.get("log").user_id = outcome.userId;
      } else {
        c.get("log").error_code = outcome.reason;
      }
      return redirect(`${deps.config.APP_ORIGIN}${outcome.location}`, 303, cookies);
    },
    { rateLimits: [RULES.auth] },
  );

  define(
    reg,
    "devLogin",
    async ({ c, body }) => {
      const deps = c.get("deps");
      if (!deps.config.AUTH_DEV_LOGIN) throw new AppError("NOT_FOUND");
      const now = deps.clock.now();
      const token = await deps.db.transaction(async (tx) => {
        const user = await upsertGithubUser(
          tx,
          devIdentity(body.githubLogin, body.githubAgeDays, now),
          deps.config,
          now,
          body.role,
        );
        if (user.status === "suspended") throw new AppError("ACCOUNT_SUSPENDED");
        const sessionToken = await createSession(tx, {
          userId: user.id,
          ip: c.get("clientIp"),
          userAgent: c.req.header("user-agent") ?? null,
          now,
        });
        await writeAudit(
          tx,
          { type: "user", userId: user.id, ip: c.get("clientIp"), requestId: c.get("requestId") },
          {
            action: "auth.login",
            targetType: "user",
            targetId: user.id,
            targetLabel: user.githubLogin,
            metadata: { method: "dev" },
          },
        );
        return sessionToken;
      });
      return new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie(token) } });
    },
    { rateLimits: [RULES.auth] },
  );

  define(
    reg,
    "logout",
    async ({ c, session, user, actor }) => {
      const deps = c.get("deps");
      await deps.db.transaction(async (tx) => {
        await revokeSessionById(tx, session.id, deps.clock.now());
        await writeAudit(tx, actor, {
          action: "auth.logout",
          targetType: "user",
          targetId: user.id,
          targetLabel: user.githubLogin,
        });
      });
      return new Response(null, {
        status: 204,
        headers: { "Set-Cookie": clearCookie(SESSION_COOKIE) },
      });
    },
    { allowSuspended: true },
  );
}
