import type { DnsRecord, RecordInput, RecordList } from "@dit/contract";
import { ErrorCode } from "@dit/contract";
import { type Verdict, validateRecord } from "@dit/dns";
import { and, asc, eq, ne } from "drizzle-orm";
import type { Actor, Deps } from "../../context.ts";
import type { Executor } from "../../db/client.ts";
import {
  dnsRecords,
  type RecordRow,
  type SubdomainRow,
  subdomains,
  type UserRow,
} from "../../db/schema.ts";
import { uuidv7 } from "../../lib/ids.ts";
import { AppError } from "../../lib/problem.ts";
import { withSyncEta, withSyncEtas } from "../../sync/batching.ts";
import { wakeWorker } from "../../sync/events-bus.ts";
import { fqdnOf } from "../../sync/mapper.ts";
import { cancelQueuedRecordJobs, enqueue } from "../../sync/queue.ts";
import { writeAudit } from "../audit/service.ts";
import { recordDataOf, recordDto, recordInputOf } from "../dto.ts";
import { countActiveRecords, userLimits, zoneUsage } from "../quota.ts";
import { loadOwnedSubdomain } from "../subdomains/service.ts";
import { normalizeRecordInput } from "./normalize.ts";

/** packages/dns 的 Verdict → problem（第一個違規的 code 若是合約錯誤碼就沿用，否則 VALIDATION_FAILED） */
export function verdictError(
  verdict: Verdict,
  fallback: ErrorCode = "VALIDATION_FAILED",
): AppError | null {
  if (verdict.ok) return null;
  const first = verdict.violations[0];
  const parsed = ErrorCode.safeParse(first?.code);
  const code = parsed.success ? parsed.data : fallback;
  return new AppError(code, first?.message, { errors: verdict.violations });
}

export function assertActive(sub: SubdomainRow): void {
  if (sub.status !== "active") {
    const detail =
      sub.status === "pending_review"
        ? "子網域還在審核中，通過後才能設定 DNS"
        : sub.status === "suspended"
          ? "子網域已被停權，無法修改 DNS"
          : "子網域正在釋出，無法修改 DNS";
    throw new AppError("SUBDOMAIN_NOT_ACTIVE", detail);
  }
}

export async function liveRecords(ex: Executor, subdomainId: string): Promise<RecordRow[]> {
  return ex
    .select()
    .from(dnsRecords)
    .where(and(eq(dnsRecords.subdomainId, subdomainId), ne(dnsRecords.syncStatus, "deleting")))
    .orderBy(asc(dnsRecords.createdAt), asc(dnsRecords.id));
}

/** 使用者擁有的子網域名稱（CNAME 指向 *.dev-in.tw 時只能指向自己的子網域） */
async function ownedNames(ex: Executor, userId: string): Promise<string[]> {
  const rows = await ex
    .select({ name: subdomains.name })
    .from(subdomains)
    .where(eq(subdomains.ownerId, userId));
  return rows.map((r) => r.name);
}

export async function validateAgainst(
  ex: Executor,
  deps: Pick<Deps, "config">,
  sub: SubdomainRow,
  input: RecordInput,
  existing: RecordRow[],
): Promise<void> {
  const verdict = validateRecord(input, {
    sub: sub.name,
    root: deps.config.ROOT_DOMAIN,
    existing: existing.map((r) => recordDto(r, sub.name, deps.config.ROOT_DOMAIN)),
    ownedSubdomains: await ownedNames(ex, sub.ownerId),
    allowedTypes: deps.config.ALLOWED_RECORD_TYPES,
    provider: deps.config.DNS_PROVIDER,
  });
  const error = verdictError(verdict);
  if (error) throw error;
}

export async function assertZoneCapacity(ex: Executor, deps: Pick<Deps, "config">, adding: number) {
  if (adding <= 0) return;
  const usage = await zoneUsage(ex, deps.config);
  if (usage.used + adding > usage.usable) {
    throw new AppError("ZONE_CAPACITY_EXHAUSTED", "整個 dev-in.tw 的紀錄容量已滿，請稍後再試");
  }
}

export async function listRecords(deps: Deps, user: UserRow, name: string): Promise<RecordList> {
  const sub = await loadOwnedSubdomain(deps.db, user.id, name);
  const rows = await deps.db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.subdomainId, sub.id))
    .orderBy(asc(dnsRecords.createdAt), asc(dnsRecords.id));
  return {
    items: await withSyncEtas(
      deps,
      rows.map((r) => recordDto(r, sub.name, deps.config.ROOT_DOMAIN)),
    ),
    usage: {
      used: rows.filter((r) => r.syncStatus !== "deleting").length,
      limit: userLimits(user, deps.config).records,
    },
  };
}

/** 新增一筆紀錄的 DB 部分（交易內）；presets 也共用 */
export async function insertRecord(
  tx: Executor,
  deps: Pick<Deps, "clock">,
  sub: SubdomainRow,
  input: RecordInput,
): Promise<RecordRow> {
  const now = deps.clock.now();
  const [row] = await tx
    .insert(dnsRecords)
    .values({
      id: uuidv7(now.getTime()),
      subdomainId: sub.id,
      name: input.name,
      type: input.type,
      ttl: input.ttl,
      data: recordDataOf(input),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  await enqueue(tx, { kind: "upsert_record", recordId: row.id, subdomainId: sub.id, runAt: now });
  return row;
}

/** 刪除一筆紀錄的 DB 部分：標成 deleting，取消還沒執行的 upsert，排入 delete */
export async function markRecordDeleting(
  tx: Executor,
  deps: Pick<Deps, "clock">,
  record: RecordRow,
): Promise<RecordRow> {
  const now = deps.clock.now();
  await cancelQueuedRecordJobs(tx, record.id);
  const [row] = await tx
    .update(dnsRecords)
    .set({
      syncStatus: "deleting",
      version: record.version + 1,
      syncErrorCode: null,
      syncErrorMessage: null,
      updatedAt: now,
    })
    .where(eq(dnsRecords.id, record.id))
    .returning();
  if (!row) throw new AppError("NOT_FOUND");
  await enqueue(tx, {
    kind: "delete_record",
    recordId: row.id,
    subdomainId: row.subdomainId,
    runAt: now,
  });
  return row;
}

const recordAudit = (sub: SubdomainRow, record: RecordRow, root: string, extra = {}) => ({
  targetType: "subdomain",
  targetId: sub.id,
  targetLabel: `${sub.name}.${root}`,
  metadata: {
    recordId: record.id,
    name: record.name,
    type: record.type,
    fqdn: fqdnOf(record.name, sub.name, root),
    ...extra,
  },
});

export async function createRecord(
  deps: Deps,
  user: UserRow,
  name: string,
  raw: RecordInput,
  actor: Actor,
): Promise<DnsRecord> {
  const input = normalizeRecordInput(raw);
  const dto = await deps.db.transaction(async (tx) => {
    // FOR UPDATE：同一個子網域的寫入序列化（配額與 CNAME 排他才不會被併發繞過）
    const sub = await loadOwnedSubdomain(tx, user.id, name, { forUpdate: true });
    assertActive(sub);
    const limit = userLimits(user, deps.config).records;
    if ((await countActiveRecords(tx, sub.id)) >= limit) {
      throw new AppError("RECORD_QUOTA_EXCEEDED", `每個子網域最多 ${limit} 筆紀錄`);
    }
    await validateAgainst(tx, deps, sub, input, await liveRecords(tx, sub.id));
    await assertZoneCapacity(tx, deps, 1);
    const row = await insertRecord(tx, deps, sub, input);
    await writeAudit(tx, actor, {
      action: "record.create",
      ...recordAudit(sub, row, deps.config.ROOT_DOMAIN),
    });
    await wakeWorker(tx);
    return recordDto(row, sub.name, deps.config.ROOT_DOMAIN);
  });
  return withSyncEta(deps, dto);
}

async function loadRecordForWrite(
  tx: Executor,
  sub: SubdomainRow,
  recordId: string,
  ifMatch: number | null,
) {
  const [record] = await tx
    .select()
    .from(dnsRecords)
    .where(and(eq(dnsRecords.id, recordId), eq(dnsRecords.subdomainId, sub.id)))
    .for("update")
    .limit(1);
  if (!record) throw new AppError("NOT_FOUND", "找不到這筆紀錄");
  if (ifMatch !== null && ifMatch !== record.version) {
    throw new AppError("VERSION_CONFLICT", "這筆紀錄已在別處被修改，請重新載入");
  }
  return record;
}

export async function replaceRecord(
  deps: Deps,
  user: UserRow,
  name: string,
  recordId: string,
  raw: RecordInput,
  ifMatch: number | null,
  actor: Actor,
): Promise<DnsRecord> {
  const input = normalizeRecordInput(raw);
  const dto = await deps.db.transaction(async (tx) => {
    const sub = await loadOwnedSubdomain(tx, user.id, name, { forUpdate: true });
    assertActive(sub);
    const record = await loadRecordForWrite(tx, sub, recordId, ifMatch);
    if (record.syncStatus === "deleting") throw new AppError("NOT_FOUND", "這筆紀錄正在刪除");
    const others = (await liveRecords(tx, sub.id)).filter((r) => r.id !== record.id);
    await validateAgainst(tx, deps, sub, input, others);
    const now = deps.clock.now();
    const [row] = await tx
      .update(dnsRecords)
      .set({
        name: input.name,
        type: input.type,
        ttl: input.ttl,
        data: recordDataOf(input),
        version: record.version + 1,
        syncStatus: "pending",
        syncErrorCode: null,
        syncErrorMessage: null,
        updatedAt: now,
      })
      .where(eq(dnsRecords.id, record.id))
      .returning();
    if (!row) throw new AppError("NOT_FOUND");
    await enqueue(tx, { kind: "upsert_record", recordId: row.id, subdomainId: sub.id, runAt: now });
    await writeAudit(tx, actor, {
      action: "record.replace",
      ...recordAudit(sub, row, deps.config.ROOT_DOMAIN, {
        before: recordInputOf(record),
        typeChanged: record.type !== row.type,
      }),
    });
    await wakeWorker(tx);
    return recordDto(row, sub.name, deps.config.ROOT_DOMAIN);
  });
  return withSyncEta(deps, dto);
}

export async function deleteRecord(
  deps: Deps,
  user: UserRow,
  name: string,
  recordId: string,
  ifMatch: number | null,
  actor: Actor,
): Promise<DnsRecord> {
  const dto = await deps.db.transaction(async (tx) => {
    const sub = await loadOwnedSubdomain(tx, user.id, name, { forUpdate: true });
    assertActive(sub);
    const record = await loadRecordForWrite(tx, sub, recordId, ifMatch);
    if (record.syncStatus === "deleting")
      return recordDto(record, sub.name, deps.config.ROOT_DOMAIN);
    const row = await markRecordDeleting(tx, deps, record);
    await writeAudit(tx, actor, {
      action: "record.delete",
      ...recordAudit(sub, record, deps.config.ROOT_DOMAIN),
    });
    await wakeWorker(tx);
    return recordDto(row, sub.name, deps.config.ROOT_DOMAIN);
  });
  return withSyncEta(deps, dto);
}

/** 失敗的紀錄重新排入同步（刪除失敗的會重新排入刪除） */
export async function retryRecordSync(
  deps: Deps,
  user: UserRow,
  name: string,
  recordId: string,
): Promise<DnsRecord> {
  const dto = await deps.db.transaction(async (tx) => {
    const sub = await loadOwnedSubdomain(tx, user.id, name, { forUpdate: true });
    assertActive(sub);
    const record = await loadRecordForWrite(tx, sub, recordId, null);
    const now = deps.clock.now();
    const deleting = record.syncStatus === "deleting";
    const [row] = await tx
      .update(dnsRecords)
      .set({
        syncStatus: deleting ? "deleting" : record.syncStatus === "synced" ? "synced" : "pending",
        syncErrorCode: null,
        syncErrorMessage: null,
        updatedAt: now,
      })
      .where(eq(dnsRecords.id, record.id))
      .returning();
    if (!row) throw new AppError("NOT_FOUND");
    if (deleting || record.syncStatus !== "synced") {
      await enqueue(tx, {
        kind: deleting ? "delete_record" : "upsert_record",
        recordId: row.id,
        subdomainId: sub.id,
        runAt: now,
      });
      await wakeWorker(tx);
    }
    return recordDto(row, sub.name, deps.config.ROOT_DOMAIN);
  });
  return withSyncEta(deps, dto);
}
