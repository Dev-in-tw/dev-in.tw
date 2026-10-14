import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { providerZoneId } from "../config.ts";
import type { Deps } from "../context.ts";
import type { Executor } from "../db/client.ts";
import { dnsProviderOwnership, dnsRecords, subdomains } from "../db/schema.ts";
import { toProviderInput } from "./mapper.ts";
import { ownershipComment, type ProviderRecord, type RrsetWriter } from "./provider-port.ts";

/**
 * 沒有 comment 的 provider（Lazco DNS）的所有權（PLAN §3.8.1）。provider 上的一個值屬於哪一筆 DB 紀錄，
 * 依序看：
 *
 * 1. dns_provider_ownership：worker 每次寫入前記下「這個值是哪一筆紀錄寫的」，寫入後修剪；
 * 2. DB 紀錄（任何狀態）的期望值算出的 id 相同。
 *
 * 判斷出來的擁有者以 `dit:<recordId>` 填回 ProviderRecord.comment，reconcile、importZoneNames 與
 * purge 的既有邏輯（大量刪除煞車、unmanaged 只回報、SYSTEM_RECORD_NAMES 永不碰）就完全不用改。
 * 兩者都沒有的值（管理員在 Lazco 面板手動建立的）是 unmanaged，永遠不會被 worker 或 reconciler 刪除。
 */

export interface OwnershipRow {
  providerId: string;
  fqdn: string;
  type: string;
  recordId: string;
}

const zoneOf = (deps: Pick<Deps, "config">): string => providerZoneId(deps.config) ?? "";

export async function loadOwnership(ex: Executor, zone: string): Promise<Map<string, string>> {
  const rows = await ex
    .select({ id: dnsProviderOwnership.providerId, recordId: dnsProviderOwnership.recordId })
    .from(dnsProviderOwnership)
    .where(eq(dnsProviderOwnership.zone, zone));
  return new Map(rows.map((r) => [r.id, r.recordId]));
}

/** 寫入前記下所有權（intent）。同一個值換了擁有者時以新的為準。 */
export async function claimOwnership(
  ex: Executor,
  zone: string,
  rows: readonly OwnershipRow[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await ex
      .insert(dnsProviderOwnership)
      .values(chunk.map((r) => ({ zone, ...r })))
      .onConflictDoUpdate({
        target: [dnsProviderOwnership.zone, dnsProviderOwnership.providerId],
        set: { recordId: sql`excluded.record_id`, updatedAt: sql`now()` },
      });
  }
}

/** 寫入後：這些 RRset 裡已經不在 provider 上的值，刪掉它們的所有權列 */
export async function pruneOwnership(
  ex: Executor,
  zone: string,
  keys: ReadonlySet<string>,
  present: ReadonlySet<string>,
): Promise<void> {
  if (keys.size === 0) return;
  const rows = await ex
    .select({
      id: dnsProviderOwnership.providerId,
      fqdn: dnsProviderOwnership.fqdn,
      type: dnsProviderOwnership.type,
    })
    .from(dnsProviderOwnership)
    .where(eq(dnsProviderOwnership.zone, zone));
  const stale = rows
    .filter((r) => keys.has(`${r.fqdn}|${r.type}`) && !present.has(r.id))
    .map((r) => r.id);
  await forgetOwnership(ex, zone, stale);
}

export async function forgetOwnership(
  ex: Executor,
  zone: string,
  ids: readonly string[],
): Promise<void> {
  for (let i = 0; i < ids.length; i += 500) {
    await ex
      .delete(dnsProviderOwnership)
      .where(
        and(
          eq(dnsProviderOwnership.zone, zone),
          inArray(dnsProviderOwnership.providerId, ids.slice(i, i + 500)),
        ),
      );
  }
}

/**
 * 對帳時：provider 上已經沒有、而且超過 olderThan 沒更新的所有權列可以刪掉。只刪舊的，避免和正在送出的
 * PATCH 互相干擾（worker 先寫 intent 才 PATCH，對帳可能剛好在中間讀到 provider）。
 */
export async function pruneStaleOwnership(
  ex: Executor,
  zone: string,
  present: ReadonlySet<string>,
  olderThan: Date,
): Promise<number> {
  const rows = await ex
    .select({ id: dnsProviderOwnership.providerId })
    .from(dnsProviderOwnership)
    .where(and(eq(dnsProviderOwnership.zone, zone), lt(dnsProviderOwnership.updatedAt, olderThan)));
  const stale = rows.map((r) => r.id).filter((id) => !present.has(id));
  await forgetOwnership(ex, zone, stale);
  return stale.length;
}

/** DB 每一筆紀錄（任何狀態）的期望值 → 紀錄 id */
export async function desiredOwners(
  deps: Pick<Deps, "db" | "config">,
  writer: Pick<RrsetWriter, "idOf" | "valueOf">,
): Promise<Map<string, string>> {
  const rows = await deps.db
    .select({ record: dnsRecords, sub: subdomains.name })
    .from(dnsRecords)
    .innerJoin(subdomains, eq(subdomains.id, dnsRecords.subdomainId));
  const out = new Map<string, string>();
  for (const { record, sub } of rows) {
    const input = toProviderInput(record, sub, deps.config.ROOT_DOMAIN);
    out.set(writer.idOf(input.fqdn, input.type, writer.valueOf(input)), record.id);
  }
  return out;
}

/** 所有權表優先，其次是 DB 期望值 */
export async function ownerIndex(
  deps: Pick<Deps, "db" | "config">,
  writer: Pick<RrsetWriter, "idOf" | "valueOf">,
): Promise<Map<string, string>> {
  const owners = await desiredOwners(deps, writer);
  for (const [id, recordId] of await loadOwnership(deps.db, zoneOf(deps))) owners.set(id, recordId);
  return owners;
}

/** 列出 provider 上的紀錄；provider 沒有 comment 時依 DB 補上 `dit:<recordId>` */
export async function listProviderRecords(
  deps: Pick<Deps, "db" | "config" | "provider">,
): Promise<ProviderRecord[]> {
  const out: ProviderRecord[] = [];
  for await (const r of deps.provider.listAll()) out.push(r);
  const writer = deps.provider.rrsets;
  if (deps.provider.supportsComments || !writer) return out;
  const owners = await ownerIndex(deps, writer);
  return out.map((r) => {
    const owner = owners.get(r.id);
    return { ...r, comment: owner ? ownershipComment(owner) : null };
  });
}

export const ownershipZone = zoneOf;
