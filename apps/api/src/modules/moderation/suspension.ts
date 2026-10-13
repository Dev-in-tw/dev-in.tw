import type { AdminSubdomain } from "@dit/contract";
import { and, eq, inArray } from "drizzle-orm";
import type { Actor, Deps } from "../../context.ts";
import type { Executor } from "../../db/client.ts";
import { nameHolds, type SubdomainRow, subdomains, users } from "../../db/schema.ts";
import { addMs, DAY } from "../../lib/clock.ts";
import { AppError } from "../../lib/problem.ts";
import { wakeWorker } from "../../sync/events-bus.ts";
import { enqueue } from "../../sync/queue.ts";
import { writeAudit } from "../audit/service.ts";
import { adminSubdomainDto } from "../dto.ts";
import { toSubdomainDto } from "../subdomains/service.ts";

export async function loadSubdomainByName(ex: Executor, name: string, forUpdate = false) {
  const query = ex
    .select()
    .from(subdomains)
    .where(eq(subdomains.name, name.toLowerCase()))
    .limit(1);
  const [row] = await (forUpdate ? query.for("update") : query);
  if (!row) throw new AppError("NOT_FOUND", "找不到這個子網域");
  return row;
}

export async function toAdminSubdomain(
  ex: Executor,
  deps: Pick<Deps, "config">,
  row: SubdomainRow,
): Promise<AdminSubdomain> {
  const [owner] = await ex.select().from(users).where(eq(users.id, row.ownerId));
  if (!owner) throw new AppError("NOT_FOUND");
  return adminSubdomainDto(await toSubdomainDto(ex, deps, row), owner);
}

const label = (deps: Pick<Deps, "config">, row: SubdomainRow) =>
  `${row.name}.${deps.config.ROOT_DOMAIN}`;

/** 停權：DB 保留，CF 紀錄撤下（PLAN §2.2）。byUser=true 表示是使用者停權連帶的。 */
export async function suspendSubdomainTx(
  tx: Executor,
  deps: Pick<Deps, "clock" | "bus" | "config">,
  row: SubdomainRow,
  reason: string,
  actor: Actor,
  byUser = false,
): Promise<SubdomainRow> {
  const now = deps.clock.now();
  const [updated] = await tx
    .update(subdomains)
    .set({
      status: "suspended",
      suspendedReason: reason,
      suspendedByUser: byUser,
      showInDirectory: false,
      updatedAt: now,
    })
    .where(eq(subdomains.id, row.id))
    .returning();
  if (!updated) throw new AppError("NOT_FOUND");
  await enqueue(tx, { kind: "purge_subdomain", subdomainId: row.id, runAt: now });
  await wakeWorker(tx);
  await writeAudit(tx, actor, {
    action: "subdomain.suspend",
    targetType: "subdomain",
    targetId: row.id,
    targetLabel: label(deps, row),
    metadata: { reason, byUser },
  });
  await deps.bus.publish(tx, [row.ownerId], {
    type: "subdomain.status",
    subdomain: row.name,
    status: "suspended",
  });
  return updated;
}

export async function unsuspendSubdomainTx(
  tx: Executor,
  deps: Pick<Deps, "clock" | "bus" | "config">,
  row: SubdomainRow,
  reason: string | undefined,
  actor: Actor,
): Promise<SubdomainRow> {
  const now = deps.clock.now();
  const [updated] = await tx
    .update(subdomains)
    .set({ status: "active", suspendedReason: null, suspendedByUser: false, updatedAt: now })
    .where(eq(subdomains.id, row.id))
    .returning();
  if (!updated) throw new AppError("NOT_FOUND");
  await enqueue(tx, { kind: "restore_subdomain", subdomainId: row.id, runAt: now });
  await wakeWorker(tx);
  await writeAudit(tx, actor, {
    action: "subdomain.unsuspend",
    targetType: "subdomain",
    targetId: row.id,
    targetLabel: label(deps, row),
    metadata: reason ? { reason } : {},
  });
  await deps.bus.publish(tx, [row.ownerId], {
    type: "subdomain.status",
    subdomain: row.name,
    status: "active",
  });
  return updated;
}

export async function adminSuspendSubdomain(
  deps: Deps,
  name: string,
  reason: string,
  actor: Actor,
) {
  return deps.db.transaction(async (tx) => {
    const row = await loadSubdomainByName(tx, name, true);
    if (row.status === "releasing") throw new AppError("SUBDOMAIN_NOT_ACTIVE", "子網域正在釋出");
    const updated =
      row.status === "suspended" ? row : await suspendSubdomainTx(tx, deps, row, reason, actor);
    return toAdminSubdomain(tx, deps, updated);
  });
}

export async function adminUnsuspendSubdomain(
  deps: Deps,
  name: string,
  reason: string | undefined,
  actor: Actor,
) {
  return deps.db.transaction(async (tx) => {
    const row = await loadSubdomainByName(tx, name, true);
    if (row.status !== "suspended")
      throw new AppError("SUBDOMAIN_NOT_ACTIVE", "子網域不在停權狀態");
    const updated = await unsuspendSubdomainTx(tx, deps, row, reason, actor);
    return toAdminSubdomain(tx, deps, updated);
  });
}

export async function adminApproveSubdomain(
  deps: Deps,
  name: string,
  reason: string | undefined,
  actor: Actor,
) {
  return deps.db.transaction(async (tx) => {
    const row = await loadSubdomainByName(tx, name, true);
    if (row.status !== "pending_review")
      throw new AppError("SUBDOMAIN_NOT_ACTIVE", "這個子網域不在待審狀態");
    const now = deps.clock.now();
    const [updated] = await tx
      .update(subdomains)
      .set({ status: "active", activatedAt: now, updatedAt: now })
      .where(eq(subdomains.id, row.id))
      .returning();
    if (!updated) throw new AppError("NOT_FOUND");
    await writeAudit(tx, actor, {
      action: "subdomain.approve",
      targetType: "subdomain",
      targetId: row.id,
      targetLabel: label(deps, row),
      metadata: reason ? { reason } : {},
    });
    await deps.bus.publish(tx, [row.ownerId], {
      type: "subdomain.status",
      subdomain: row.name,
      status: "active",
    });
    return toAdminSubdomain(tx, deps, updated);
  });
}

/** 駁回：待審的子網域沒有任何紀錄，直接刪除並讓名稱進入冷卻 */
export async function adminRejectSubdomain(deps: Deps, name: string, reason: string, actor: Actor) {
  return deps.db.transaction(async (tx) => {
    const row = await loadSubdomainByName(tx, name, true);
    if (row.status !== "pending_review")
      throw new AppError("SUBDOMAIN_NOT_ACTIVE", "這個子網域不在待審狀態");
    const snapshot = await toAdminSubdomain(tx, deps, { ...row, status: "releasing" });
    const now = deps.clock.now();
    await tx.delete(subdomains).where(eq(subdomains.id, row.id));
    const holdUntil = addMs(now, deps.config.NAME_COOLDOWN_DAYS * DAY);
    await tx
      .insert(nameHolds)
      .values({ name: row.name, previousOwnerId: row.ownerId, reason: "admin_rejected", holdUntil })
      .onConflictDoUpdate({ target: nameHolds.name, set: { reason: "admin_rejected", holdUntil } });
    await writeAudit(tx, actor, {
      action: "subdomain.reject",
      targetType: "subdomain",
      targetId: row.id,
      targetLabel: label(deps, row),
      metadata: { reason },
    });
    await deps.bus.publish(tx, [row.ownerId], {
      type: "subdomain.status",
      subdomain: row.name,
      status: "releasing",
    });
    return snapshot;
  });
}

/** 使用者停權：撤銷 session，啟用中的子網域一併停權（解除時只恢復因此被停權的） */
export async function suspendUserSubdomains(
  tx: Executor,
  deps: Pick<Deps, "clock" | "bus" | "config">,
  userId: string,
  reason: string,
  actor: Actor,
) {
  const rows = await tx
    .select()
    .from(subdomains)
    .where(
      and(eq(subdomains.ownerId, userId), inArray(subdomains.status, ["active", "pending_review"])),
    )
    .for("update");
  for (const row of rows)
    await suspendSubdomainTx(tx, deps, row, `帳號停權：${reason}`, actor, true);
}

export async function unsuspendUserSubdomains(
  tx: Executor,
  deps: Pick<Deps, "clock" | "bus" | "config">,
  userId: string,
  actor: Actor,
) {
  const rows = await tx
    .select()
    .from(subdomains)
    .where(
      and(
        eq(subdomains.ownerId, userId),
        eq(subdomains.status, "suspended"),
        eq(subdomains.suspendedByUser, true),
      ),
    )
    .for("update");
  for (const row of rows) await unsuspendSubdomainTx(tx, deps, row, "帳號解除停權", actor);
}
