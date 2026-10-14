import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Executor } from "../db/client.ts";
import { dnsRecords, subdomains, type UserRow } from "../db/schema.ts";
import { getSetting } from "./settings.ts";

export function userLimits(
  user: Pick<UserRow, "quotaSubdomains" | "quotaRecords">,
  config: Config,
) {
  return {
    subdomains: user.quotaSubdomains ?? config.MAX_SUBDOMAINS_PER_USER,
    records: user.quotaRecords ?? config.MAX_RECORDS_PER_SUBDOMAIN,
  };
}

/** 佔用名額的子網域（釋出中的也算，直到真的刪除為止） */
export async function countOwnedSubdomains(ex: Executor, userId: string): Promise<number> {
  const [row] = await ex
    .select({ n: count() })
    .from(subdomains)
    .where(eq(subdomains.ownerId, userId));
  return row?.n ?? 0;
}

/** 刪除中的紀錄不佔名額 */
export async function countActiveRecords(ex: Executor, subdomainId: string): Promise<number> {
  const [row] = await ex
    .select({ n: count() })
    .from(dnsRecords)
    .where(and(eq(dnsRecords.subdomainId, subdomainId), ne(dnsRecords.syncStatus, "deleting")));
  return row?.n ?? 0;
}

export async function recordCounts(
  ex: Executor,
  subdomainIds: string[],
): Promise<Map<string, number>> {
  if (subdomainIds.length === 0) return new Map();
  const rows = await ex
    .select({ id: dnsRecords.subdomainId, n: count() })
    .from(dnsRecords)
    .where(
      and(inArray(dnsRecords.subdomainId, subdomainIds), ne(dnsRecords.syncStatus, "deleting")),
    )
    .groupBy(dnsRecords.subdomainId);
  return new Map(rows.map((r) => [r.id, r.n]));
}

/** zone 容量的單位：Lazco DNS 以 RRset（同名同類型）計算，其他 provider 以紀錄計算 */
export const usageUnit = (config: Pick<Config, "DNS_PROVIDER">): "record" | "rrset" =>
  config.DNS_PROVIDER === "lazco" ? "rrset" : "record";

/**
 * zone 使用量 = provider 上沒有 dit: 標記的紀錄（系統紀錄等，取自最近一次對帳的快照）
 * + DB 裡所有受管紀錄。可用上限 = ZONE_RECORD_LIMIT − ZONE_HEADROOM（PLAN §3.1）。
 * Lazco DNS 的單位是 RRset：受管的部分以 (子網域, 名稱, 類型) 去重，ZONE_RECORD_LIMIT 是 RRset 上限
 * （PLAN §3.8.1）。同名同類型的第二筆紀錄不多佔容量。
 */
export async function zoneUsage(ex: Executor, config: Config) {
  const snapshot = await getSetting(ex, "zone_snapshot");
  const [row] = await ex.execute<{ n: string }>(
    usageUnit(config) === "rrset"
      ? sql`select count(*) as n from (select distinct subdomain_id, name, type from dns_records) t`
      : sql`select count(*) as n from dns_records`,
  );
  const managed = Number(row?.n ?? 0);
  const unmanaged = snapshot?.unmanagedCount ?? config.SYSTEM_RECORD_NAMES.length;
  const used = unmanaged + managed;
  const limit = config.ZONE_RECORD_LIMIT;
  const usable = limit - config.ZONE_HEADROOM;
  return { used, limit, usable, managed, unmanaged, remaining: Math.max(0, usable - used) };
}
