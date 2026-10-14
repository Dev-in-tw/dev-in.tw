import { acceptLegal } from "../../modules/identity/consent.ts";
import {
  deleteMe,
  getMe,
  listMyActivity,
  listSessions,
  revokeOtherSessions,
  revokeSession,
  updateMe,
} from "../../modules/identity/me.ts";
import { clearCookie, SESSION_COOKIE } from "../../modules/identity/sessions.ts";
import { define, type Registry } from "../define.ts";
import { RULES } from "../middleware/rate-limit.ts";

export function meRoutes(reg: Registry): void {
  define(reg, "getMe", ({ c, user }) => getMe(c.get("deps"), user));
  define(reg, "updateMe", ({ c, user, body }) => updateMe(c.get("deps"), user, body));
  define(reg, "deleteMe", async ({ c, user, body, actor }) => {
    await deleteMe(c.get("deps"), user, body.confirm, actor);
    return new Response(null, {
      status: 202,
      headers: { "Set-Cookie": clearCookie(SESSION_COOKIE) },
    });
  });
  define(reg, "listSessions", async ({ c, user, session }) => ({
    items: await listSessions(c.get("deps"), user, session),
  }));
  define(reg, "revokeSession", async ({ c, user, params, actor }) => {
    await revokeSession(c.get("deps"), user, params.sessionId, actor);
    return new Response(null, { status: 204 });
  });
  define(reg, "revokeOtherSessions", async ({ c, user, session, actor }) => {
    await revokeOtherSessions(c.get("deps"), user, session, actor);
    return new Response(null, { status: 204 });
  });
  define(
    reg,
    "acceptLegal",
    ({ c, user, body, actor }) => acceptLegal(c.get("deps"), user, body, actor),
    {
      rateLimits: [RULES.consent],
    },
  );
  define(reg, "listMyActivity", ({ c, user, query }) => listMyActivity(c.get("deps"), user, query));
}
