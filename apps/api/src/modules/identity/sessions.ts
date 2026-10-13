import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { type SessionRow, sessions, type UserRow, users } from "../../db/schema.ts";
import { addMs, DAY, HOUR } from "../../lib/clock.ts";
import { randomToken, sha256Hex } from "../../lib/crypto.ts";
import { uuidv7 } from "../../lib/ids.ts";

export const SESSION_COOKIE = "__Host-dit_session";
export const OAUTH_COOKIE = "__Host-dit_oauth";
export const IDLE_MS = 14 * DAY;
export const ABSOLUTE_MS = 60 * DAY;
const TOUCH_AFTER_MS = HOUR;

/**
 * `__Host-` 前綴：瀏覽器拒絕帶 Domain 屬性、必須 Secure 與 Path=/，使用者子網域無法覆寫（cookie tossing）。
 * Max-Age 等於 absolute 期限；實際是否有效以 server 端的 idle 與 absolute 期限為準（PLAN §3.7）。
 */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ABSOLUTE_MS / 1000}`;
}
export function clearCookie(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function createSession(
  ex: Executor,
  input: { userId: string; ip: string | null; userAgent: string | null; now: Date },
): Promise<string> {
  const token = randomToken(32);
  await ex.insert(sessions).values({
    id: sha256Hex(token),
    publicId: uuidv7(input.now.getTime()),
    userId: input.userId,
    createdAt: input.now,
    lastSeenAt: input.now,
    idleExpiresAt: addMs(input.now, IDLE_MS),
    absoluteExpiresAt: addMs(input.now, ABSOLUTE_MS),
    ip: input.ip,
    userAgent: input.userAgent?.slice(0, 400) ?? null,
  });
  return token;
}

export interface ResolvedSession {
  session: SessionRow;
  user: UserRow;
}

/** 用 sha256(cookie) 查 session，檢查撤銷與 idle / absolute 期限；閒置超過 1 小時才延長 */
export async function resolveSession(
  ex: Executor,
  token: string,
  now: Date,
): Promise<ResolvedSession | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [row] = await ex
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sha256Hex(token)))
    .limit(1);
  if (!row) return null;
  const { session, user } = row;
  if (session.revokedAt) return null;
  if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) return null;
  if (user.deletionRequestedAt) return null;
  if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
    const idle = new Date(Math.min(now.getTime() + IDLE_MS, session.absoluteExpiresAt.getTime()));
    await ex
      .update(sessions)
      .set({ lastSeenAt: now, idleExpiresAt: idle })
      .where(eq(sessions.id, session.id));
    session.lastSeenAt = now;
    session.idleExpiresAt = idle;
  }
  return { session, user };
}

export async function revokeSessionById(ex: Executor, sessionId: string, now: Date) {
  await ex
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/** 撤銷使用者所有 session（可保留目前這一個） */
export async function revokeUserSessions(
  ex: Executor,
  userId: string,
  now: Date,
  exceptSessionId?: string,
): Promise<number> {
  const rows = await ex
    .update(sessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        exceptSessionId ? ne(sessions.id, exceptSessionId) : sql`true`,
      ),
    )
    .returning({ id: sessions.id });
  return rows.length;
}
