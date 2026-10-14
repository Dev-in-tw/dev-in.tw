import {
  DATA_EXPORT_FORMAT,
  type ExportActivity,
  type ExportRecord,
  type ExportTransfer,
  type UserDataExport,
} from "@dit/contract";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import type { Actor, Deps } from "../../context.ts";
import {
  auditLogs,
  dnsRecords,
  legalConsents,
  reports,
  sessions,
  subdomains,
  transfers,
  type UserRow,
  users,
} from "../../db/schema.ts";
import { writeAudit } from "../audit/service.ts";
import { iso, isoOrNull, recordDto } from "../dto.ts";
import { toSubdomainDtos } from "../subdomains/service.ts";

/** 稽核紀錄最多匯出這麼多筆（保存期限 1 年，正常使用遠低於這個數字） */
export const EXPORT_ACTIVITY_LIMIT = 5000;

/**
 * GET /me/export（隱私權政策第 11 條：查詢、閱覽、製給複製本）。
 *
 * 只輸出這個使用者自己的資料。刻意排除：session token 與其雜湊（sessions.id）、檢舉人的 IP 雜湊、
 * 管理員的處理備註與身分、其他使用者的 email／IP／內部 id。轉移與稽核紀錄裡出現的其他人，只有
 * GitHub 帳號名稱這類公開資訊。
 */
export async function exportMyData(
  deps: Deps,
  user: UserRow,
  actor: Actor,
): Promise<UserDataExport> {
  const now = deps.clock.now();
  const owned = await deps.db
    .select()
    .from(subdomains)
    .where(eq(subdomains.ownerId, user.id))
    .orderBy(asc(subdomains.createdAt));
  const ownedIds = owned.map((s) => s.id);
  const nameById = new Map(owned.map((s) => [s.id, s.name]));

  const [subdomainDtos, recordRows, auditRows, sessionRows, transferRows, consentRows, reportRows] =
    await Promise.all([
      toSubdomainDtos(deps.db, deps, owned),
      ownedIds.length
        ? deps.db
            .select()
            .from(dnsRecords)
            .where(inArray(dnsRecords.subdomainId, ownedIds))
            .orderBy(asc(dnsRecords.createdAt))
        : Promise.resolve([]),
      deps.db
        .select()
        .from(auditLogs)
        .where(
          or(
            eq(auditLogs.actorUserId, user.id),
            and(eq(auditLogs.targetType, "user"), eq(auditLogs.targetId, user.id)),
          ),
        )
        .orderBy(desc(auditLogs.id))
        .limit(EXPORT_ACTIVITY_LIMIT),
      deps.db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, user.id))
        .orderBy(desc(sessions.createdAt)),
      deps.db
        .select()
        .from(transfers)
        .where(or(eq(transfers.fromUserId, user.id), eq(transfers.toUserId, user.id)))
        .orderBy(desc(transfers.createdAt)),
      deps.db
        .select()
        .from(legalConsents)
        .where(eq(legalConsents.userId, user.id))
        .orderBy(asc(legalConsents.seq)),
      deps.db
        .select()
        .from(reports)
        .where(eq(reports.reporterUserId, user.id))
        .orderBy(desc(reports.createdAt)),
    ]);

  const records: ExportRecord[] = recordRows.map((r) => {
    const sub = nameById.get(r.subdomainId) ?? "";
    return { ...recordDto(r, sub, deps.config.ROOT_DOMAIN), subdomain: sub };
  });

  const activity: ExportActivity[] = auditRows.map((r) => {
    const self = r.actorUserId === user.id;
    return {
      id: r.id,
      action: r.action,
      actorType: self ? "user" : r.actorType,
      target: { type: r.targetType, id: r.targetId, label: r.targetLabel },
      metadata: r.metadata,
      ip: self ? r.ip : null,
      createdAt: iso(r.createdAt),
    };
  });

  // 轉移：子網域名稱與對方的 GitHub 帳號名稱（對方的 email、id 不輸出）
  const counterpartIds = [
    ...new Set(transferRows.map((t) => (t.fromUserId === user.id ? t.toUserId : t.fromUserId))),
  ];
  const transferSubIds = [...new Set(transferRows.map((t) => t.subdomainId))];
  const [counterparts, transferSubs] = await Promise.all([
    counterpartIds.length
      ? deps.db
          .select({ id: users.id, login: users.githubLogin })
          .from(users)
          .where(inArray(users.id, counterpartIds))
      : Promise.resolve([]),
    transferSubIds.length
      ? deps.db
          .select({ id: subdomains.id, name: subdomains.name })
          .from(subdomains)
          .where(inArray(subdomains.id, transferSubIds))
      : Promise.resolve([]),
  ]);
  const loginById = new Map(counterparts.map((u) => [u.id, u.login]));
  const subNameById = new Map(transferSubs.map((s) => [s.id, s.name]));
  const transferItems: ExportTransfer[] = transferRows.map((t) => {
    const outgoing = t.fromUserId === user.id;
    return {
      id: t.id,
      subdomain: subNameById.get(t.subdomainId) ?? null,
      direction: outgoing ? "outgoing" : "incoming",
      counterpart: loginById.get(outgoing ? t.toUserId : t.fromUserId) ?? null,
      status: t.status,
      keepRecords: t.keepRecords,
      createdAt: iso(t.createdAt),
      expiresAt: iso(t.expiresAt),
      resolvedAt: isoOrNull(t.resolvedAt),
    };
  });

  await writeAudit(deps.db, actor, {
    action: "user.export",
    targetType: "user",
    targetId: user.id,
    targetLabel: user.githubLogin,
  });

  return {
    format: DATA_EXPORT_FORMAT,
    generatedAt: iso(now),
    account: {
      id: user.id,
      githubId: user.githubId,
      githubLogin: user.githubLogin,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      email: user.email,
      githubCreatedAt: iso(user.githubCreatedAt),
      role: user.role,
      status: user.status,
      suspendedReason: user.suspendedReason,
      createdAt: iso(user.createdAt),
      lastLoginAt: iso(user.lastLoginAt),
    },
    subdomains: subdomainDtos,
    records,
    activity,
    sessions: sessionRows.map((s) => ({
      id: s.publicId,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: iso(s.createdAt),
      lastSeenAt: iso(s.lastSeenAt),
      idleExpiresAt: iso(s.idleExpiresAt),
      absoluteExpiresAt: iso(s.absoluteExpiresAt),
      revokedAt: isoOrNull(s.revokedAt),
    })),
    transfers: transferItems,
    consents: consentRows.map((c) => ({
      termsVersion: c.termsVersion,
      privacyVersion: c.privacyVersion,
      context: c.context,
      acceptedAt: iso(c.acceptedAt),
    })),
    reports: reportRows.map((r) => ({
      id: r.id,
      subdomain: r.subdomainName,
      category: r.category,
      details: r.details,
      contactEmail: r.contactEmail,
      status: r.status,
      createdAt: iso(r.createdAt),
      resolvedAt: isoOrNull(r.resolvedAt),
    })),
  };
}

/** 下載檔名：dev-in-tw-<login>-<yyyy-mm-dd>.json（login 只含英數與連字號，不需要跳脫） */
export function exportFilename(user: Pick<UserRow, "githubLogin">, now: Date): string {
  return `dev-in-tw-${user.githubLogin.toLowerCase()}-${now.toISOString().slice(0, 10)}.json`;
}
