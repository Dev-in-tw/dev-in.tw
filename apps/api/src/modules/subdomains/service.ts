import type { CreateSubdomainBody, Subdomain, UpdateSubdomainBody } from "@dit/contract";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor, Deps } from "../../context.ts";
import type { Executor } from "../../db/client.ts";
import { type SubdomainRow, subdomains, transfers, type UserRow, users } from "../../db/schema.ts";
import { uuidv7 } from "../../lib/ids.ts";
import { AppError } from "../../lib/problem.ts";
import { wakeWorker } from "../../sync/events-bus.ts";
import { enqueue } from "../../sync/queue.ts";
import { writeAudit } from "../audit/service.ts";
import { subdomainDto } from "../dto.ts";
import { checkSubdomainConsent, recordConsent } from "../identity/consent.ts";
import { decideName } from "../naming/availability.ts";
import { countOwnedSubdomains, recordCounts, userLimits } from "../quota.ts";
import { getSetting } from "../settings.ts";

/** 讀取使用者擁有的子網域；不是自己的一律當作不存在（IDOR 回 404，PLAN §3.6） */
export async function loadOwnedSubdomain(
  ex: Executor,
  ownerId: string,
  name: string,
  opts: { forUpdate?: boolean } = {},
): Promise<SubdomainRow> {
  const query = ex
    .select()
    .from(subdomains)
    .where(and(eq(subdomains.name, name.toLowerCase()), eq(subdomains.ownerId, ownerId)))
    .limit(1);
  const [row] = await (opts.forUpdate ? query.for("update") : query);
  if (!row) throw new AppError("NOT_FOUND", "找不到這個子網域");
  return row;
}

export async function pendingTransferIds(ex: Executor, subdomainIds: string[]) {
  if (subdomainIds.length === 0) return new Map<string, string>();
  const rows = await ex
    .select({ subdomainId: transfers.subdomainId, id: transfers.id })
    .from(transfers)
    .where(and(inArray(transfers.subdomainId, subdomainIds), eq(transfers.status, "pending")));
  return new Map(rows.map((r) => [r.subdomainId, r.id]));
}

/** 一次組出多個子網域的 DTO（紀錄數、轉移狀態、擁有者的配額） */
export async function toSubdomainDtos(
  ex: Executor,
  deps: Pick<Deps, "config">,
  rows: SubdomainRow[],
): Promise<Subdomain[]> {
  const ids = rows.map((r) => r.id);
  const ownerIds = [...new Set(rows.map((r) => r.ownerId))];
  const [counts, pending, owners] = await Promise.all([
    recordCounts(ex, ids),
    pendingTransferIds(ex, ids),
    ownerIds.length
      ? ex.select().from(users).where(inArray(users.id, ownerIds))
      : Promise.resolve([] as UserRow[]),
  ]);
  const ownerMap = new Map(owners.map((u) => [u.id, u]));
  return rows.map((row) => {
    const owner = ownerMap.get(row.ownerId);
    return subdomainDto(row, {
      root: deps.config.ROOT_DOMAIN,
      recordsUsed: counts.get(row.id) ?? 0,
      recordsLimit: owner
        ? userLimits(owner, deps.config).records
        : deps.config.MAX_RECORDS_PER_SUBDOMAIN,
      pendingTransferId: pending.get(row.id) ?? null,
    });
  });
}

export async function toSubdomainDto(ex: Executor, deps: Pick<Deps, "config">, row: SubdomainRow) {
  const [dto] = await toSubdomainDtos(ex, deps, [row]);
  if (!dto) throw new Error("unreachable");
  return dto;
}

export async function listSubdomains(deps: Deps, user: UserRow): Promise<Subdomain[]> {
  const rows = await deps.db
    .select()
    .from(subdomains)
    .where(eq(subdomains.ownerId, user.id))
    .orderBy(desc(subdomains.createdAt));
  return toSubdomainDtos(deps.db, deps, rows);
}

export async function getSubdomain(deps: Deps, user: UserRow, name: string): Promise<Subdomain> {
  const row = await loadOwnedSubdomain(deps.db, user.id, name);
  return toSubdomainDto(deps.db, deps, row);
}

const NAME_ERRORS = {
  invalid: "NAME_INVALID",
  reserved: "NAME_RESERVED",
  taken: "NAME_TAKEN",
  cooldown: "NAME_COOLDOWN",
  capacity_full: "ZONE_CAPACITY_EXHAUSTED",
} as const;

export async function createSubdomain(
  deps: Deps,
  user: UserRow,
  body: CreateSubdomainBody,
  actor: Actor,
): Promise<Subdomain> {
  const now = deps.clock.now();
  if (!(await getSetting(deps.db, "registration_open"))) {
    throw new AppError("REGISTRATION_CLOSED", "目前暫停開放申請");
  }
  const limits = userLimits(user, deps.config);
  if ((await countOwnedSubdomains(deps.db, user.id)) >= limits.subdomains) {
    throw new AppError("SUBDOMAIN_QUOTA_EXCEEDED", `每個帳號最多 ${limits.subdomains} 個子網域`);
  }
  const decision = await decideName(deps.db, deps.config, body.name, user, now);
  if (decision.status !== "available" && decision.status !== "review") {
    throw new AppError(NAME_ERRORS[decision.status], decision.reason);
  }
  const recordAgreement = await checkSubdomainConsent(deps.db, user, {
    termsVersion: body.termsVersion,
    privacyVersion: body.privacyVersion,
  });
  if (!(await deps.turnstile.verify(body.turnstileToken, actor.ip))) {
    throw new AppError("TURNSTILE_FAILED", "人機驗證失敗，請重新驗證");
  }

  const review = decision.status === "review";
  const row = await deps.db.transaction(async (tx) => {
    // 鎖住使用者，序列化同一個人的申請，避免併發繞過配額
    await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for("update");
    if ((await countOwnedSubdomains(tx, user.id)) >= limits.subdomains) {
      throw new AppError("SUBDOMAIN_QUOTA_EXCEEDED", `每個帳號最多 ${limits.subdomains} 個子網域`);
    }
    const [created] = await tx
      .insert(subdomains)
      .values({
        id: uuidv7(now.getTime()),
        name: decision.name,
        ownerId: user.id,
        status: review ? "pending_review" : "active",
        description: body.description,
        reviewReasons: decision.reviewReasons,
        createdAt: now,
        updatedAt: now,
        activatedAt: review ? null : now,
      })
      .onConflictDoNothing({ target: subdomains.name })
      .returning();
    if (!created) throw new AppError("NAME_TAKEN", "這個名稱已經有人使用");
    if (recordAgreement) await recordConsent(tx, user.id, "subdomain_create", now);
    await writeAudit(tx, actor, {
      action: "subdomain.create",
      targetType: "subdomain",
      targetId: created.id,
      targetLabel: `${created.name}.${deps.config.ROOT_DOMAIN}`,
      metadata: {
        status: created.status,
        reviewReasons: created.reviewReasons,
        ...(recordAgreement
          ? { termsVersion: body.termsVersion, privacyVersion: body.privacyVersion }
          : {}),
      },
    });
    return created;
  });

  if (review) {
    deps.notifier.notify({
      key: `review:${row.id}`,
      title: "新的待審子網域",
      description: `\`${row.name}.${deps.config.ROOT_DOMAIN}\`（申請人 ${user.githubLogin}）`,
      severity: "info",
      fields: [{ name: "原因", value: row.reviewReasons.join(", ") }],
      url: `${deps.config.APP_ORIGIN}/admin/review`,
    });
  }
  return toSubdomainDto(deps.db, deps, row);
}

export async function updateSubdomain(
  deps: Deps,
  user: UserRow,
  name: string,
  body: UpdateSubdomainBody,
  actor: Actor,
): Promise<Subdomain> {
  return deps.db.transaction(async (tx) => {
    const row = await loadOwnedSubdomain(tx, user.id, name, { forUpdate: true });
    const patch: Partial<SubdomainRow> = {};
    if (body.description !== undefined) patch.description = body.description;
    if (body.showInDirectory !== undefined) patch.showInDirectory = body.showInDirectory;
    if (Object.keys(patch).length === 0) return toSubdomainDto(tx, deps, row);
    const [updated] = await tx
      .update(subdomains)
      .set({ ...patch, updatedAt: deps.clock.now() })
      .where(eq(subdomains.id, row.id))
      .returning();
    if (!updated) throw new AppError("NOT_FOUND");
    await writeAudit(tx, actor, {
      action: "subdomain.update",
      targetType: "subdomain",
      targetId: row.id,
      targetLabel: `${row.name}.${deps.config.ROOT_DOMAIN}`,
      metadata: patch,
    });
    return toSubdomainDto(tx, deps, updated);
  });
}

/**
 * 把子網域標成 releasing 並排入 purge：worker 刪掉 provider 上的紀錄後，刪除子網域並寫入冷卻期。
 * 呼叫端負責權限檢查與稽核。
 */
export async function markReleasing(
  tx: Executor,
  deps: Pick<Deps, "clock" | "bus">,
  row: SubdomainRow,
): Promise<SubdomainRow> {
  const now = deps.clock.now();
  const [updated] = await tx
    .update(subdomains)
    .set({ status: "releasing", showInDirectory: false, updatedAt: now })
    .where(eq(subdomains.id, row.id))
    .returning();
  if (!updated) throw new AppError("NOT_FOUND");
  await tx
    .update(transfers)
    .set({ status: "cancelled", resolvedAt: now })
    .where(and(eq(transfers.subdomainId, row.id), eq(transfers.status, "pending")));
  await enqueue(tx, { kind: "purge_subdomain", subdomainId: row.id, runAt: now });
  await wakeWorker(tx);
  await deps.bus.publish(tx, [row.ownerId], {
    type: "subdomain.status",
    subdomain: row.name,
    status: "releasing",
  });
  return updated;
}

export async function releaseSubdomain(
  deps: Deps,
  user: UserRow,
  name: string,
  confirm: string,
  actor: Actor,
): Promise<Subdomain> {
  return deps.db.transaction(async (tx) => {
    const row = await loadOwnedSubdomain(tx, user.id, name, { forUpdate: true });
    if (confirm.trim().toLowerCase() !== row.name) {
      throw new AppError("CONFIRMATION_MISMATCH", "請輸入完整的子網域名稱確認");
    }
    if (row.status === "releasing") return toSubdomainDto(tx, deps, row);
    if (row.status === "suspended") {
      throw new AppError("SUBDOMAIN_NOT_ACTIVE", "停權中的子網域不能自行釋出，請聯絡管理員");
    }
    const updated = await markReleasing(tx, deps, row);
    await writeAudit(tx, actor, {
      action: "subdomain.release",
      targetType: "subdomain",
      targetId: row.id,
      targetLabel: `${row.name}.${deps.config.ROOT_DOMAIN}`,
    });
    return toSubdomainDto(tx, deps, updated);
  });
}
