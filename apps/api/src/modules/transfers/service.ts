import type { CreateTransferBody, Transfer, TransferList } from "@dit/contract";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { Actor, Deps } from "../../context.ts";
import type { Executor } from "../../db/client.ts";
import {
  dnsRecords,
  subdomains,
  type TransferRow,
  transfers,
  type UserRow,
  users,
} from "../../db/schema.ts";
import { addMs, DAY } from "../../lib/clock.ts";
import { uuidv7 } from "../../lib/ids.ts";
import { AppError } from "../../lib/problem.ts";
import { wakeWorker } from "../../sync/events-bus.ts";
import { writeAudit } from "../audit/service.ts";
import { iso, isoOrNull, publicUser } from "../dto.ts";
import { findUserByLogin } from "../identity/users.ts";
import { countOwnedSubdomains, userLimits } from "../quota.ts";
import { markRecordDeleting } from "../records/service.ts";
import { loadOwnedSubdomain } from "../subdomains/service.ts";

const TRANSFER_TTL_MS = 7 * DAY;

async function toTransfers(ex: Executor, rows: TransferRow[]): Promise<Transfer[]> {
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.flatMap((r) => [r.fromUserId, r.toUserId]))];
  const subIds = [...new Set(rows.map((r) => r.subdomainId))];
  const [people, subs] = await Promise.all([
    ex.select().from(users).where(inArray(users.id, userIds)),
    ex
      .select({ id: subdomains.id, name: subdomains.name })
      .from(subdomains)
      .where(inArray(subdomains.id, subIds)),
  ]);
  const u = new Map(people.map((p) => [p.id, p]));
  const s = new Map(subs.map((x) => [x.id, x.name]));
  return rows.flatMap((r) => {
    const from = u.get(r.fromUserId);
    const to = u.get(r.toUserId);
    const name = s.get(r.subdomainId);
    if (!from || !to || !name) return [];
    return [
      {
        id: r.id,
        subdomain: name,
        from: publicUser(from),
        to: publicUser(to),
        status: r.status,
        keepRecords: r.keepRecords,
        createdAt: iso(r.createdAt),
        expiresAt: iso(r.expiresAt),
        resolvedAt: isoOrNull(r.resolvedAt),
      },
    ];
  });
}

export async function listTransfers(deps: Deps, user: UserRow): Promise<TransferList> {
  const rows = await deps.db
    .select()
    .from(transfers)
    .where(or(eq(transfers.toUserId, user.id), eq(transfers.fromUserId, user.id)))
    .orderBy(desc(transfers.createdAt))
    .limit(100);
  const all = await toTransfers(deps.db, rows);
  const incoming = new Set(rows.filter((r) => r.toUserId === user.id).map((r) => r.id));
  return {
    incoming: all.filter((t) => incoming.has(t.id)),
    outgoing: all.filter((t) => !incoming.has(t.id)),
  };
}

export async function createTransfer(
  deps: Deps,
  user: UserRow,
  name: string,
  body: CreateTransferBody,
  actor: Actor,
): Promise<Transfer> {
  return deps.db.transaction(async (tx) => {
    const sub = await loadOwnedSubdomain(tx, user.id, name, { forUpdate: true });
    if (sub.status !== "active")
      throw new AppError("SUBDOMAIN_NOT_ACTIVE", "只有啟用中的子網域可以轉移");
    const recipient = await findUserByLogin(tx, body.toGithubLogin);
    if (!recipient || recipient.id === user.id || recipient.status !== "active") {
      throw new AppError(
        "TRANSFER_RECIPIENT_NOT_FOUND",
        "找不到這位使用者（對方需要先登入過 Dev-in.tw）",
      );
    }
    const now = deps.clock.now();
    const [row] = await tx
      .insert(transfers)
      .values({
        id: uuidv7(now.getTime()),
        subdomainId: sub.id,
        fromUserId: user.id,
        toUserId: recipient.id,
        keepRecords: body.keepRecords,
        createdAt: now,
        expiresAt: addMs(now, TRANSFER_TTL_MS),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new AppError("TRANSFER_ALREADY_PENDING", "這個子網域已經有一筆待處理的轉移");
    await writeAudit(tx, actor, {
      action: "transfer.create",
      targetType: "subdomain",
      targetId: sub.id,
      targetLabel: `${sub.name}.${deps.config.ROOT_DOMAIN}`,
      metadata: { transferId: row.id, to: recipient.githubLogin, keepRecords: row.keepRecords },
    });
    await deps.bus.publish(tx, [user.id, recipient.id], {
      type: "transfer.updated",
      transferId: row.id,
      status: "pending",
    });
    const [dto] = await toTransfers(tx, [row]);
    if (!dto) throw new Error("unreachable");
    return dto;
  });
}

type Decision = "accept" | "decline" | "cancel";

export async function resolveTransfer(
  deps: Deps,
  user: UserRow,
  transferId: string,
  decision: Decision,
  actor: Actor,
): Promise<Transfer> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(transfers)
      .where(eq(transfers.id, transferId))
      .for("update")
      .limit(1);
    const allowed =
      row && (decision === "cancel" ? row.fromUserId === user.id : row.toUserId === user.id);
    if (!row || !allowed) throw new AppError("NOT_FOUND", "找不到這筆轉移");
    const now = deps.clock.now();
    if (row.status !== "pending" || row.expiresAt <= now) {
      throw new AppError("TRANSFER_INVALID_STATE", "這筆轉移已經處理過或已過期");
    }
    const [sub] = await tx
      .select()
      .from(subdomains)
      .where(eq(subdomains.id, row.subdomainId))
      .for("update");
    if (!sub) throw new AppError("NOT_FOUND");

    if (decision === "accept") {
      if (sub.status !== "active" || sub.ownerId !== row.fromUserId) {
        throw new AppError("TRANSFER_INVALID_STATE", "子網域狀態已改變，無法接受轉移");
      }
      await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for("update");
      if ((await countOwnedSubdomains(tx, user.id)) >= userLimits(user, deps.config).subdomains) {
        throw new AppError("TRANSFER_RECIPIENT_QUOTA", "你的子網域數量已達上限");
      }
      await tx
        .update(subdomains)
        .set({ ownerId: user.id, showInDirectory: false, updatedAt: now })
        .where(eq(subdomains.id, sub.id));
      if (!row.keepRecords) {
        const records = await tx
          .select()
          .from(dnsRecords)
          .where(eq(dnsRecords.subdomainId, sub.id));
        for (const record of records) {
          if (record.syncStatus !== "deleting") await markRecordDeleting(tx, deps, record);
        }
        await wakeWorker(tx);
      }
    }
    const status =
      decision === "accept" ? "accepted" : decision === "decline" ? "declined" : "cancelled";
    const [updated] = await tx
      .update(transfers)
      .set({ status, resolvedAt: now })
      .where(eq(transfers.id, row.id))
      .returning();
    if (!updated) throw new AppError("NOT_FOUND");
    await writeAudit(tx, actor, {
      action: `transfer.${decision}`,
      targetType: "subdomain",
      targetId: sub.id,
      targetLabel: `${sub.name}.${deps.config.ROOT_DOMAIN}`,
      metadata: { transferId: row.id, keepRecords: row.keepRecords },
    });
    await deps.bus.publish(tx, [row.fromUserId, row.toUserId], {
      type: "transfer.updated",
      transferId: row.id,
      status,
    });
    const [dto] = await toTransfers(tx, [updated]);
    if (!dto) throw new Error("unreachable");
    return dto;
  });
}

/** housekeeping：過期的轉移 */
export async function expireTransfers(deps: Deps): Promise<number> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const expired = await tx
      .update(transfers)
      .set({ status: "expired", resolvedAt: now })
      .where(and(eq(transfers.status, "pending"), lt(transfers.expiresAt, now)))
      .returning();
    for (const t of expired) {
      await deps.bus.publish(tx, [t.fromUserId, t.toUserId], {
        type: "transfer.updated",
        transferId: t.id,
        status: "expired",
      });
      await writeAudit(
        tx,
        { type: "system", userId: null, ip: null, requestId: null },
        {
          action: "transfer.expire",
          targetType: "subdomain",
          targetId: t.subdomainId,
          targetLabel: t.subdomainId,
          metadata: { transferId: t.id },
        },
      );
    }
    return expired.length;
  });
}
