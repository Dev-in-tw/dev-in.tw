import type { DirectoryEntry, Meta, ServiceStatus, Stats } from "@dit/contract";
import { and, count, countDistinct, desc, eq, lt, sql } from "drizzle-orm";
import type { Deps } from "../../context.ts";
import { dnsRecords, subdomains, users } from "../../db/schema.ts";
import { queueStats } from "../../sync/queue.ts";
import { lastReconcileAt } from "../../sync/reconciler.ts";
import { decodeCursor, iso, pageOf, publicUser } from "../dto.ts";
import { zoneUsage } from "../quota.ts";
import { getSetting } from "../settings.ts";

export async function getMeta(deps: Deps): Promise<Meta> {
  const { config } = deps;
  const [registrationOpen, usage] = await Promise.all([
    getSetting(deps.db, "registration_open"),
    zoneUsage(deps.db, config),
  ]);
  return {
    rootDomain: config.ROOT_DOMAIN,
    turnstileSiteKey: config.TURNSTILE_SITE_KEY,
    registrationOpen,
    limits: {
      subdomainsPerUser: config.MAX_SUBDOMAINS_PER_USER,
      recordsPerSubdomain: config.MAX_RECORDS_PER_SUBDOMAIN,
      nameMinLength: 3,
      nameMaxLength: 32,
    },
    allowedRecordTypes: config.ALLOWED_RECORD_TYPES,
    zoneNearlyFull: usage.used >= usage.limit * 0.9,
    github: { org: config.PUBLIC_GITHUB_URL, discord: config.PUBLIC_DISCORD_URL ?? null },
  };
}

const directoryQuery = (deps: Deps) =>
  deps.db
    .select({ sub: subdomains, owner: users })
    .from(subdomains)
    .innerJoin(users, eq(users.id, subdomains.ownerId))
    .$dynamic();

function toEntry(
  deps: Deps,
  row: { sub: typeof subdomains.$inferSelect; owner: typeof users.$inferSelect },
): DirectoryEntry {
  return {
    name: row.sub.name,
    fqdn: `${row.sub.name}.${deps.config.ROOT_DOMAIN}`,
    description: row.sub.description,
    owner: publicUser(row.owner),
    since: iso(row.sub.activatedAt ?? row.sub.createdAt),
  };
}

/** 公開成員展示：只列出 opt-in 且啟用中的子網域（預設不公開，PLAN §6 Q17） */
export async function listDirectory(
  deps: Deps,
  page: { cursor?: string | undefined; limit: number },
) {
  const cursor = decodeCursor(page.cursor);
  const visible = and(
    eq(subdomains.status, "active"),
    eq(subdomains.showInDirectory, true),
    eq(users.status, "active"),
  );
  const rows = await directoryQuery(deps)
    .where(cursor ? and(visible, lt(subdomains.id, cursor)) : visible)
    .orderBy(desc(subdomains.id))
    .limit(page.limit + 1);
  const result = pageOf(rows, page.limit, (r) => r.sub.id);
  return { items: result.items.map((r) => toEntry(deps, r)), nextCursor: result.nextCursor };
}

export async function getStats(deps: Deps): Promise<Stats> {
  const [[subs], [records], latest] = await Promise.all([
    deps.db
      .select({ n: count(), members: countDistinct(subdomains.ownerId) })
      .from(subdomains)
      .where(eq(subdomains.status, "active")),
    deps.db
      .select({ n: count() })
      .from(dnsRecords)
      .innerJoin(subdomains, eq(subdomains.id, dnsRecords.subdomainId))
      .where(eq(subdomains.status, "active")),
    directoryQuery(deps)
      .where(
        and(
          eq(subdomains.status, "active"),
          eq(subdomains.showInDirectory, true),
          eq(users.status, "active"),
        ),
      )
      .orderBy(desc(subdomains.activatedAt))
      .limit(10),
  ]);
  return {
    subdomains: subs?.n ?? 0,
    members: subs?.members ?? 0,
    records: records?.n ?? 0,
    latest: latest.map((r) => toEntry(deps, r)),
  };
}

export async function getStatus(deps: Deps): Promise<ServiceStatus> {
  const now = deps.clock.now();
  let database: ServiceStatus["components"][number] = {
    id: "database",
    status: "operational",
    detail: null,
  };
  let stats = { pending: 0, failed: 0, oldestPendingSeconds: null as number | null };
  let reconciledAt: string | null = null;
  try {
    await Promise.race([
      deps.db.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000).unref()),
    ]);
    stats = await queueStats(deps.db, now);
    reconciledAt = await lastReconcileAt(deps);
  } catch {
    database = { id: "database", status: "down", detail: "資料庫無法連線" };
  }
  const { runtime } = deps;
  const provider: ServiceStatus["components"][number] = runtime.providerAuthFailed
    ? { id: "dns_provider", status: "degraded", detail: "DNS 服務認證失敗，同步暫停中" }
    : { id: "dns_provider", status: "operational", detail: null };
  const heartbeatAge = runtime.workerHeartbeat
    ? now.getTime() - runtime.workerHeartbeat.getTime()
    : null;
  const worker: ServiceStatus["components"][number] = !runtime.workerEnabled
    ? { id: "sync_worker", status: "degraded", detail: "同步 worker 未啟用" }
    : heartbeatAge === null || heartbeatAge > 30_000
      ? { id: "sync_worker", status: "down", detail: "同步 worker 沒有回應" }
      : (stats.oldestPendingSeconds ?? 0) > 300 || stats.failed > 0
        ? { id: "sync_worker", status: "degraded", detail: "同步佇列延遲中" }
        : { id: "sync_worker", status: "operational", detail: null };
  const components = [
    { id: "api" as const, status: "operational" as const, detail: null },
    database,
    provider,
    worker,
  ];
  const overall = components.some((c) => c.status === "down")
    ? "down"
    : components.some((c) => c.status === "degraded")
      ? "degraded"
      : "operational";
  return {
    overall,
    components,
    syncQueue: stats,
    lastReconcileAt: reconciledAt,
    checkedAt: now.toISOString(),
  };
}
