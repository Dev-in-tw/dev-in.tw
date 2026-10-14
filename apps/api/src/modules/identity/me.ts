import { isCurrentConsent, type Me, type Session } from "@dit/contract";
import { and, count, desc, eq, gt, isNull, max } from "drizzle-orm";
import type { Actor, Deps } from "../../context.ts";
import {
  type SessionRow,
  sessions,
  subdomains,
  transfers,
  type UserRow,
  users,
} from "../../db/schema.ts";
import { approximateIp } from "../../lib/net.ts";
import { AppError } from "../../lib/problem.ts";
import { queryAudit } from "../audit/query.ts";
import { writeAudit } from "../audit/service.ts";
import { iso } from "../dto.ts";
import { countOwnedSubdomains, userLimits } from "../quota.ts";
import { loadOwnedSubdomain, markReleasing } from "../subdomains/service.ts";
import { consentDto, latestConsent } from "./consent.ts";
import { revokeSessionById, revokeUserSessions } from "./sessions.ts";

export async function getMe(deps: Deps, user: UserRow): Promise<Me> {
  const limits = userLimits(user, deps.config);
  const [used, [incoming], consent] = await Promise.all([
    countOwnedSubdomains(deps.db, user.id),
    deps.db
      .select({ n: count() })
      .from(transfers)
      .where(
        and(
          eq(transfers.toUserId, user.id),
          eq(transfers.status, "pending"),
          gt(transfers.expiresAt, deps.clock.now()),
        ),
      ),
    latestConsent(deps.db, user.id),
  ]);
  return {
    id: user.id,
    githubId: user.githubId,
    githubLogin: user.githubLogin,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    email: user.email,
    role: user.role,
    status: user.status,
    quota: { subdomains: { used, limit: limits.subdomains }, recordsPerSubdomain: limits.records },
    incomingTransfers: incoming?.n ?? 0,
    createdAt: iso(user.createdAt),
    consent: consent ? consentDto(consent) : null,
    consentRequired: !isCurrentConsent(consent),
  };
}

export async function updateMe(
  deps: Deps,
  user: UserRow,
  body: { displayName?: string | null | undefined },
): Promise<Me> {
  if (body.displayName === undefined) return getMe(deps, user);
  const displayName =
    body.displayName === null || body.displayName === "" ? null : body.displayName;
  const [updated] = await deps.db
    .update(users)
    .set({ displayName, updatedAt: deps.clock.now() })
    .where(eq(users.id, user.id))
    .returning();
  return getMe(deps, updated ?? user);
}

/**
 * 刪除帳號（202）：所有子網域進入釋出流程、撤銷所有 session、清除 email 與顯示名稱。
 * 子網域都清掉之後，housekeeping 才會真正刪除 user（稽核紀錄的 actor 會變成 null）。
 */
export async function deleteMe(
  deps: Deps,
  user: UserRow,
  confirm: string,
  actor: Actor,
): Promise<void> {
  if (confirm.trim().toLowerCase() !== user.githubLogin.toLowerCase()) {
    throw new AppError("CONFIRMATION_MISMATCH", "請輸入你的 GitHub 帳號名稱確認");
  }
  await deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    const owned = await tx
      .select()
      .from(subdomains)
      .where(eq(subdomains.ownerId, user.id))
      .for("update");
    for (const sub of owned) {
      if (sub.status !== "releasing") await markReleasing(tx, deps, sub);
    }
    await revokeUserSessions(tx, user.id, now);
    await tx
      .update(users)
      .set({ deletionRequestedAt: now, email: null, displayName: null, updatedAt: now })
      .where(eq(users.id, user.id));
    await writeAudit(tx, actor, {
      action: "user.delete",
      targetType: "user",
      targetId: user.id,
      targetLabel: user.githubLogin,
      metadata: { subdomains: owned.map((s) => s.name) },
    });
  });
}

export async function listSessions(
  deps: Deps,
  user: UserRow,
  current: SessionRow,
): Promise<Session[]> {
  const now = deps.clock.now();
  const rows = await deps.db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, user.id),
        isNull(sessions.revokedAt),
        gt(sessions.idleExpiresAt, now),
        gt(sessions.absoluteExpiresAt, now),
      ),
    )
    .orderBy(desc(sessions.lastSeenAt));
  return rows.map((s) => ({
    id: s.publicId,
    current: s.id === current.id,
    userAgent: s.userAgent,
    ipApprox: approximateIp(s.ip),
    createdAt: iso(s.createdAt),
    lastSeenAt: iso(s.lastSeenAt),
  }));
}

export async function revokeSession(
  deps: Deps,
  user: UserRow,
  publicId: string,
  actor: Actor,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(publicId)) throw new AppError("NOT_FOUND", "找不到這個裝置");
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.publicId, publicId), eq(sessions.userId, user.id)))
      .limit(1);
    if (!row) throw new AppError("NOT_FOUND", "找不到這個裝置");
    await revokeSessionById(tx, row.id, deps.clock.now());
    await writeAudit(tx, actor, {
      action: "session.revoke",
      targetType: "user",
      targetId: user.id,
      targetLabel: user.githubLogin,
      metadata: { sessionId: publicId },
    });
  });
}

export async function revokeOtherSessions(
  deps: Deps,
  user: UserRow,
  current: SessionRow,
  actor: Actor,
) {
  await deps.db.transaction(async (tx) => {
    const revoked = await revokeUserSessions(tx, user.id, deps.clock.now(), current.id);
    await writeAudit(tx, actor, {
      action: "session.revoke",
      targetType: "user",
      targetId: user.id,
      targetLabel: user.githubLogin,
      metadata: { others: true, count: revoked },
    });
  });
}

export function listMyActivity(
  deps: Deps,
  user: UserRow,
  page: { cursor?: string | undefined; limit: number },
) {
  return queryAudit(deps.db, { actorId: user.id }, page);
}

/** 子網域時間軸：只顯示目前擁有者取得之後的事件（轉移前的紀錄屬於前一位擁有者） */
export async function listSubdomainActivity(
  deps: Deps,
  user: UserRow,
  name: string,
  page: { cursor?: string | undefined; limit: number },
) {
  const sub = await loadOwnedSubdomain(deps.db, user.id, name);
  const [acquired] = await deps.db
    .select({ at: max(transfers.resolvedAt) })
    .from(transfers)
    .where(and(eq(transfers.subdomainId, sub.id), eq(transfers.status, "accepted")));
  return queryAudit(
    deps.db,
    { targetType: "subdomain", targetId: sub.id, since: acquired?.at ?? undefined },
    page,
  );
}
