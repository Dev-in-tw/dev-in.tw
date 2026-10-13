import type {
  AddReservedBody,
  AdminOverview,
  AdminSettings,
  AdminUpdateUserBody,
  AdminUser,
  ReservedCategory,
  ReservedName,
  SubdomainStatus,
  UserStatus,
  ZoneReport,
} from "@dit/contract";
import { and, count, desc, eq, gt, ilike, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import { type Actor, type Deps, runInBackground } from "../../context.ts";
import { dnsSyncJobs, reports, reservedNames, subdomains, users } from "../../db/schema.ts";
import { AppError } from "../../lib/problem.ts";
import { reconcile } from "../../sync/reconciler.ts";
import { writeAudit } from "../audit/service.ts";
import { adminSubdomainDto, adminUserDto, decodeCursor, iso, pageOf, publicUser } from "../dto.ts";
import { revokeUserSessions } from "../identity/sessions.ts";
import { suspendUserSubdomains, unsuspendUserSubdomains } from "../moderation/suspension.ts";
import { zoneUsage } from "../quota.ts";
import { getSetting, getSettings, setSetting } from "../settings.ts";
import { toSubdomainDtos } from "../subdomains/service.ts";

const likeEscape = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export async function adminOverview(deps: Deps): Promise<AdminOverview> {
  const [[pending], [open], [failed], [userCount], [subCount], usage] = await Promise.all([
    deps.db.select({ n: count() }).from(subdomains).where(eq(subdomains.status, "pending_review")),
    deps.db.select({ n: count() }).from(reports).where(eq(reports.status, "open")),
    deps.db.execute<{ n: string }>(
      sql`select count(*) as n from dns_records where sync_status = 'error' or sync_error_code is not null`,
    ),
    deps.db.select({ n: count() }).from(users),
    deps.db.select({ n: count() }).from(subdomains),
    zoneUsage(deps.db, deps.config),
  ]);
  return {
    pendingReview: pending?.n ?? 0,
    openReports: open?.n ?? 0,
    failedSyncs: Number(failed?.n ?? 0),
    zone: { used: usage.used, limit: usage.limit },
    users: userCount?.n ?? 0,
    subdomains: subCount?.n ?? 0,
  };
}

async function subdomainCounts(deps: Deps, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, number>();
  const rows = await deps.db
    .select({ id: subdomains.ownerId, n: count() })
    .from(subdomains)
    .where(inArray(subdomains.ownerId, userIds))
    .groupBy(subdomains.ownerId);
  return new Map(rows.map((r) => [r.id, r.n]));
}

export async function adminListUsers(
  deps: Deps,
  query: {
    q?: string | undefined;
    status?: UserStatus | undefined;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const conditions: SQL[] = [];
  if (query.q) {
    const q = query.q.trim();
    const numeric = /^\d{1,19}$/.test(q) ? eq(users.githubId, Number(q)) : undefined;
    const byLogin = ilike(users.githubLogin, likeEscape(q));
    conditions.push(numeric ? (or(byLogin, numeric) as SQL) : byLogin);
  }
  if (query.status) conditions.push(eq(users.status, query.status));
  const cursor = decodeCursor(query.cursor);
  if (cursor) conditions.push(lt(users.id, cursor));
  const rows = await deps.db
    .select()
    .from(users)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(users.id))
    .limit(query.limit + 1);
  const page = pageOf(rows, query.limit, (r) => r.id);
  const counts = await subdomainCounts(
    deps,
    page.items.map((u) => u.id),
  );
  return {
    items: page.items.map((u) => adminUserDto(u, counts.get(u.id) ?? 0)),
    nextCursor: page.nextCursor,
  };
}

export async function adminUpdateUser(
  deps: Deps,
  userId: string,
  body: AdminUpdateUserBody,
  actor: Actor,
): Promise<AdminUser> {
  return deps.db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update").limit(1);
    if (!user) throw new AppError("NOT_FOUND", "找不到這位使用者");
    const now = deps.clock.now();
    const label = user.githubLogin;
    if (body.status && body.status !== user.status) {
      if (user.id === actor.userId) throw new AppError("FORBIDDEN", "不能停權自己");
      const reason = body.reason?.trim() || (body.status === "suspended" ? "管理員停權" : "");
      await tx
        .update(users)
        .set({
          status: body.status,
          suspendedReason: body.status === "suspended" ? reason : null,
          updatedAt: now,
        })
        .where(eq(users.id, user.id));
      if (body.status === "suspended") {
        await revokeUserSessions(tx, user.id, now);
        await suspendUserSubdomains(tx, deps, user.id, reason, actor);
      } else {
        await unsuspendUserSubdomains(tx, deps, user.id, actor);
      }
      await writeAudit(tx, actor, {
        action: body.status === "suspended" ? "user.suspend" : "user.unsuspend",
        targetType: "user",
        targetId: user.id,
        targetLabel: label,
        metadata: { reason },
      });
    }
    if (body.quotaOverride !== undefined) {
      const quota = body.quotaOverride;
      await tx
        .update(users)
        .set({
          quotaSubdomains: quota?.subdomains ?? null,
          quotaRecords: quota?.recordsPerSubdomain ?? null,
          updatedAt: now,
        })
        .where(eq(users.id, user.id));
      await writeAudit(tx, actor, {
        action: "user.quota_change",
        targetType: "user",
        targetId: user.id,
        targetLabel: label,
        metadata: { quotaOverride: quota, ...(body.reason ? { reason: body.reason } : {}) },
      });
    }
    const [updated] = await tx.select().from(users).where(eq(users.id, user.id));
    if (!updated) throw new AppError("NOT_FOUND");
    const [c] = await tx
      .select({ n: count() })
      .from(subdomains)
      .where(eq(subdomains.ownerId, user.id));
    return adminUserDto(updated, c?.n ?? 0);
  });
}

export async function adminListSubdomains(
  deps: Deps,
  query: {
    q?: string | undefined;
    status?: SubdomainStatus | undefined;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const conditions: SQL[] = [];
  if (query.q) {
    const q = likeEscape(query.q.trim());
    conditions.push(or(ilike(subdomains.name, q), ilike(users.githubLogin, q)) as SQL);
  }
  if (query.status) conditions.push(eq(subdomains.status, query.status));
  const cursor = decodeCursor(query.cursor);
  if (cursor) conditions.push(lt(subdomains.id, cursor));
  const rows = await deps.db
    .select({ sub: subdomains, owner: users })
    .from(subdomains)
    .innerJoin(users, eq(users.id, subdomains.ownerId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(subdomains.id))
    .limit(query.limit + 1);
  const page = pageOf(rows, query.limit, (r) => r.sub.id);
  const dtos = await toSubdomainDtos(
    deps.db,
    deps,
    page.items.map((r) => r.sub),
  );
  return {
    items: dtos.map((dto, i) =>
      adminSubdomainDto(dto, (page.items[i] as (typeof rows)[number]).owner),
    ),
    nextCursor: page.nextCursor,
  };
}

export async function adminListReserved(
  deps: Deps,
  query: {
    q?: string | undefined;
    category?: ReservedCategory | undefined;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const conditions: SQL[] = [];
  if (query.q) conditions.push(ilike(reservedNames.name, likeEscape(query.q.trim())));
  if (query.category) conditions.push(eq(reservedNames.category, query.category));
  const cursor = decodeCursor(query.cursor);
  if (cursor) conditions.push(gt(reservedNames.name, cursor));
  const rows = await deps.db
    .select({ r: reservedNames, by: users })
    .from(reservedNames)
    .leftJoin(users, eq(users.id, reservedNames.createdBy))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(reservedNames.name)
    .limit(query.limit + 1);
  const page = pageOf(rows, query.limit, (r) => r.r.name);
  return {
    items: page.items.map(
      (row): ReservedName => ({
        name: row.r.name,
        category: row.r.category,
        note: row.r.note,
        createdBy: row.by ? publicUser(row.by) : null,
        createdAt: iso(row.r.createdAt),
      }),
    ),
    nextCursor: page.nextCursor,
  };
}

export async function adminAddReserved(
  deps: Deps,
  body: AddReservedBody,
  actor: Actor,
): Promise<ReservedName> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(reservedNames)
      .values({
        name: body.name,
        category: body.category,
        note: body.note ?? null,
        createdBy: actor.userId,
      })
      .onConflictDoUpdate({
        target: reservedNames.name,
        set: { category: body.category, note: body.note ?? null, createdBy: actor.userId },
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    await writeAudit(tx, actor, {
      action: "reserved.add",
      targetType: "reserved_name",
      targetId: row.name,
      targetLabel: row.name,
      metadata: { category: row.category },
    });
    const [by] = actor.userId
      ? await tx.select().from(users).where(eq(users.id, actor.userId))
      : [];
    return {
      name: row.name,
      category: row.category,
      note: row.note,
      createdBy: by ? publicUser(by) : null,
      createdAt: iso(row.createdAt),
    };
  });
}

export async function adminRemoveReserved(deps: Deps, name: string, actor: Actor): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .delete(reservedNames)
      .where(eq(reservedNames.name, name.toLowerCase()))
      .returning();
    if (!row) throw new AppError("NOT_FOUND", "找不到這個保留字");
    await writeAudit(tx, actor, {
      action: "reserved.remove",
      targetType: "reserved_name",
      targetId: row.name,
      targetLabel: row.name,
      metadata: { category: row.category },
    });
  });
}

export async function adminZone(deps: Deps): Promise<ZoneReport> {
  const [usage, report, dead] = await Promise.all([
    zoneUsage(deps.db, deps.config),
    getSetting(deps.db, "reconcile_report"),
    deps.db
      .select()
      .from(dnsSyncJobs)
      .where(eq(dnsSyncJobs.status, "dead"))
      .orderBy(desc(dnsSyncJobs.updatedAt))
      .limit(50),
  ]);
  const snapshot = await getSetting(deps.db, "zone_snapshot");
  const drift = [...(report?.drift ?? [])];
  if (report?.outcome === "blocked" && report.blockedReason) {
    drift.unshift({
      kind: "orphan",
      fqdn: deps.config.ROOT_DOMAIN,
      type: "-",
      detail: `待確認：${report.blockedReason}`,
    });
  }
  return {
    plan: snapshot?.plan ?? null,
    usage: { used: usage.used, limit: usage.limit },
    systemRecords: usage.unmanaged,
    managedRecords: usage.managed,
    drift,
    deadJobs: dead.map((j) => ({
      id: j.id,
      kind: j.kind,
      lastError: j.lastError,
      updatedAt: iso(j.updatedAt),
    })),
    lastReconcileAt: report?.at ?? null,
  };
}

/** 202：對帳在背景執行；force=true 才會越過大量刪除煞車 */
export async function adminReconcile(deps: Deps, force: boolean, actor: Actor): Promise<void> {
  runInBackground(deps, () => reconcile(deps, { force, actor: { ...actor, type: "admin" } }));
}

export async function adminGetSettings(deps: Deps): Promise<AdminSettings> {
  const s = await getSettings(deps.db, ["registration_open", "review_mode"]);
  return { registrationOpen: s.registration_open, reviewMode: s.review_mode };
}

export async function adminUpdateSettings(
  deps: Deps,
  body: {
    registrationOpen?: boolean | undefined;
    reviewMode?: AdminSettings["reviewMode"] | undefined;
  },
  actor: Actor,
): Promise<AdminSettings> {
  await deps.db.transaction(async (tx) => {
    if (body.registrationOpen !== undefined)
      await setSetting(tx, "registration_open", body.registrationOpen);
    if (body.reviewMode !== undefined) await setSetting(tx, "review_mode", body.reviewMode);
    await writeAudit(tx, actor, {
      action: "settings.update",
      targetType: "settings",
      targetId: "global",
      targetLabel: "settings",
      metadata: body,
    });
  });
  return adminGetSettings(deps);
}
