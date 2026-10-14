import { eq } from "drizzle-orm";
import { type Actor, type Deps, SYSTEM_ACTOR } from "../context.ts";
import { dnsRecords, reservedNames, subdomains } from "../db/schema.ts";
import { writeAudit } from "../modules/audit/service.ts";
import {
  type DriftItem,
  getSetting,
  type ReconcileReport,
  setSetting,
} from "../modules/settings.ts";
import { wakeWorker } from "./events-bus.ts";
import { fqdnOf, sameRecord, toProviderInput } from "./mapper.ts";
import { type ProviderRecord, parseOwnership } from "./provider-port.ts";
import { enqueue } from "./queue.ts";

/** 任意固定的 advisory lock key（"dit_rec"），確保同時只有一個實例在對帳 */
const RECONCILE_LOCK_KEY = "28548153004385635";
const ORPHAN_RATIO = 0.1;

export interface ReconcileOptions {
  force?: boolean;
  actor?: Actor;
}

function systemFqdns(deps: Pick<Deps, "config">): Set<string> {
  const root = deps.config.ROOT_DOMAIN;
  return new Set(deps.config.SYSTEM_RECORD_NAMES.map((n) => (n === "@" ? root : `${n}.${root}`)));
}

/** 掃一次 provider，更新 zone 快照（容量閘門與 /status 用）。啟動時與每輪對帳都會呼叫。 */
export async function refreshZoneSnapshot(deps: Deps, records?: ProviderRecord[]) {
  const list = records ?? (await collect(deps));
  const info = await deps.provider.zoneInfo();
  const unmanagedCount = list.filter((r) => !parseOwnership(r.comment)).length;
  const snapshot = {
    recordCount: list.length,
    unmanagedCount,
    plan: info.plan,
    at: deps.clock.now().toISOString(),
  };
  await setSetting(deps.db, "zone_snapshot", snapshot);
  const ratio = list.length / deps.config.ZONE_RECORD_LIMIT;
  if (ratio >= 0.95 || ratio >= 0.8) {
    const level = ratio >= 0.95 ? 95 : 80;
    deps.notifier.notify({
      key: `zone-usage-${level}`,
      title: `Zone 使用量已達 ${level}%`,
      description: `${list.length} / ${deps.config.ZONE_RECORD_LIMIT} 筆紀錄`,
      severity: level >= 95 ? "critical" : "warning",
      url: `${deps.config.APP_ORIGIN}/admin/zone`,
    });
  }
  return snapshot;
}

async function collect(deps: Pick<Deps, "provider">): Promise<ProviderRecord[]> {
  const out: ProviderRecord[] = [];
  for await (const r of deps.provider.listAll()) out.push(r);
  return out;
}

/**
 * 啟動時把 zone 既有、不是本系統建立的名稱匯入保留字（類別 zone，PLAN §5.2），避免使用者
 * 申請到管理員手動建立的名稱（修正 D-19）。
 */
export async function importZoneNames(deps: Deps, records?: ProviderRecord[]): Promise<string[]> {
  const list = records ?? (await collect(deps));
  const root = deps.config.ROOT_DOMAIN;
  const registered = new Set(
    (await deps.db.select({ name: subdomains.name }).from(subdomains)).map((r) =>
      r.name.toLowerCase(),
    ),
  );
  const labels = new Set<string>();
  for (const r of list) {
    if (parseOwnership(r.comment)) continue;
    if (!r.fqdn.endsWith(`.${root}`)) continue;
    const rest = r.fqdn.slice(0, -root.length - 1);
    const label = rest.split(".").at(-1);
    if (!label || label.startsWith("_") || label === "*" || registered.has(label)) continue;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) continue;
    labels.add(label);
  }
  const names = [...labels];
  if (names.length > 0) {
    await deps.db
      .insert(reservedNames)
      .values(
        names.map((name) => ({
          name,
          category: "zone" as const,
          note: "zone 既有名稱（自動匯入）",
        })),
      )
      .onConflictDoNothing();
  }
  return names;
}

/**
 * Reconciler（PLAN §3.8）。DB 是期望狀態，provider 是實際狀態：
 * - missing：DB 已 synced、provider 上不見了 → 重新排入
 * - modified：內容不同 → 重新排入，寫稽核 record.drift_corrected
 * - orphan：provider 上有 dit: 標記、但 DB 沒有（或子網域已停權）→ 刪除，受大量刪除煞車保護
 * - unmanaged：落在使用者子網域範圍、沒有 dit: 標記 → 只回報
 * SYSTEM_RECORD_NAMES 永遠不碰。
 */
export async function reconcile(
  deps: Deps,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport | null> {
  const reserved = await deps.sql.reserve();
  try {
    const [lock] = await reserved<
      { ok: boolean }[]
    >`select pg_try_advisory_lock(${RECONCILE_LOCK_KEY}::bigint) as ok`;
    if (!lock?.ok) return null;
    try {
      return await runReconcile(deps, opts);
    } finally {
      await reserved`select pg_advisory_unlock(${RECONCILE_LOCK_KEY}::bigint)`;
    }
  } finally {
    reserved.release();
  }
}

async function runReconcile(deps: Deps, opts: ReconcileOptions): Promise<ReconcileReport> {
  const { config, clock, notifier } = deps;
  const root = config.ROOT_DOMAIN;
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const force = opts.force ?? false;
  const at = clock.now().toISOString();

  let providerRecords: ProviderRecord[];
  try {
    providerRecords = await collect(deps);
  } catch (error) {
    deps.logger.error({ err: error }, "reconcile: listing provider records failed");
    const report: ReconcileReport = {
      at,
      outcome: "failed",
      forced: force,
      drift: [],
      orphansDeleted: 0,
      blockedReason: "無法讀取 DNS provider 的紀錄",
    };
    await setSetting(deps.db, "reconcile_report", report);
    return report;
  }
  // 管理員在啟動之後才手動加到 zone 的名稱，也要在下一輪對帳時變成保留字；否則使用者可以申請
  // 同名的子網域，並在底下加 _acme-challenge 之類的紀錄替那個名稱拿憑證
  try {
    const imported = await importZoneNames(deps, providerRecords);
    if (imported.length > 0) deps.logger.info({ imported }, "reconcile: zone names reserved");
  } catch (error) {
    deps.logger.warn({ err: error }, "reconcile: importing zone names failed");
  }
  const system = systemFqdns(deps);
  const candidates = providerRecords.filter((r) => !system.has(r.fqdn));

  const rows = await deps.db
    .select({ record: dnsRecords, sub: subdomains })
    .from(dnsRecords)
    .innerJoin(subdomains, eq(subdomains.id, dnsRecords.subdomainId));
  const subs = await deps.db
    .select({ name: subdomains.name, status: subdomains.status })
    .from(subdomains);
  const byId = new Map(rows.map((r) => [r.record.id, r]));
  const byProviderId = new Map(candidates.map((r) => [r.id, r]));
  const byComment = new Map<string, ProviderRecord>();
  for (const r of candidates) {
    const owner = parseOwnership(r.comment);
    if (owner) byComment.set(owner, r);
  }

  const drift: DriftItem[] = [];
  const toResync: {
    recordId: string;
    subdomainId: string;
    kind: "missing" | "modified";
    fqdn: string;
    type: string;
  }[] = [];
  for (const { record, sub } of rows) {
    if (sub.status !== "active" || record.syncStatus !== "synced") continue;
    const fqdn = fqdnOf(record.name, sub.name, root);
    const actual =
      (record.providerRecordId ? byProviderId.get(record.providerRecordId) : undefined) ??
      byComment.get(record.id);
    if (!actual) {
      drift.push({ kind: "missing", fqdn, type: record.type, detail: "provider 上找不到這筆紀錄" });
      toResync.push({
        recordId: record.id,
        subdomainId: sub.id,
        kind: "missing",
        fqdn,
        type: record.type,
      });
    } else if (!sameRecord(toProviderInput(record, sub.name, root), actual)) {
      drift.push({
        kind: "modified",
        fqdn,
        type: record.type,
        detail: "provider 上的內容與資料庫不同",
      });
      toResync.push({
        recordId: record.id,
        subdomainId: sub.id,
        kind: "modified",
        fqdn,
        type: record.type,
      });
    }
  }

  const orphans: ProviderRecord[] = [];
  for (const r of candidates) {
    const owner = parseOwnership(r.comment);
    if (!owner) continue;
    const row = byId.get(owner);
    const stale = !row || row.sub.status === "suspended";
    if (stale && row?.sub.status !== "releasing") {
      orphans.push(r);
      drift.push({
        kind: "orphan",
        fqdn: r.fqdn,
        type: r.type,
        detail: row ? "子網域已停權" : "資料庫沒有對應的紀錄",
      });
    }
  }

  const userScopes = subs.map((s) => `${s.name.toLowerCase()}.${root}`);
  for (const r of candidates) {
    if (parseOwnership(r.comment)) continue;
    if (userScopes.some((scope) => r.fqdn === scope || r.fqdn.endsWith(`.${scope}`))) {
      drift.push({
        kind: "unmanaged",
        fqdn: r.fqdn,
        type: r.type,
        detail: "不是本系統建立的紀錄，未自動處理",
      });
    }
  }

  // 大量刪除煞車：DATABASE_URL 指錯、DB 是空的或還原到舊版本時，避免一次把整個 zone 刪光
  const managed = rows.length;
  const threshold = Math.max(1, Math.floor(managed * ORPHAN_RATIO));
  const tooMany =
    orphans.length > config.RECONCILE_MAX_ORPHAN_DELETES || orphans.length > threshold;
  if (tooMany && !force) {
    const blockedReason = `預計刪除 ${orphans.length} 筆孤兒紀錄，超過上限（${config.RECONCILE_MAX_ORPHAN_DELETES} 筆或受管紀錄的 10%），本輪已中止`;
    const report: ReconcileReport = {
      at,
      outcome: "blocked",
      forced: false,
      drift,
      orphansDeleted: 0,
      blockedReason,
    };
    await setSetting(deps.db, "reconcile_report", report);
    notifier.notify({
      key: "reconcile-blocked",
      title: "對帳被大量刪除煞車擋下",
      description: `${blockedReason}。確認無誤後請在 /admin/zone 以 force 重新執行。`,
      severity: "critical",
      url: `${config.APP_ORIGIN}/admin/zone`,
    });
    await refreshZoneSnapshot(deps, providerRecords).catch(() => {});
    return report;
  }

  let orphansDeleted = 0;
  for (let i = 0; i < orphans.length; i += 100) {
    const chunk = orphans.slice(i, i + 100).map((r) => r.id);
    await deps.provider.batch({ deletes: chunk, replaces: [], creates: [] });
    orphansDeleted += chunk.length;
  }

  await deps.db.transaction(async (tx) => {
    const now = clock.now();
    for (const item of toResync) {
      await tx
        .update(dnsRecords)
        .set({
          syncStatus: "pending",
          ...(item.kind === "missing" ? { providerRecordId: null, providerType: null } : {}),
          updatedAt: now,
        })
        .where(eq(dnsRecords.id, item.recordId));
      await enqueue(tx, {
        kind: "upsert_record",
        recordId: item.recordId,
        subdomainId: item.subdomainId,
        runAt: now,
      });
      if (item.kind === "modified") {
        await writeAudit(tx, actor, {
          action: "record.drift_corrected",
          targetType: "subdomain",
          targetId: item.subdomainId,
          targetLabel: item.fqdn,
          metadata: { recordId: item.recordId, type: item.type },
        });
      }
    }
    await writeAudit(tx, actor, {
      action: "zone.reconcile",
      targetType: "zone",
      targetId: root,
      targetLabel: root,
      metadata: {
        forced: force,
        missing: drift.filter((d) => d.kind === "missing").length,
        modified: drift.filter((d) => d.kind === "modified").length,
        orphansDeleted,
        unmanaged: drift.filter((d) => d.kind === "unmanaged").length,
      },
    });
    if (toResync.length > 0) await wakeWorker(tx);
  });

  const report: ReconcileReport = {
    at,
    outcome: "ok",
    forced: force,
    drift,
    orphansDeleted,
    blockedReason: null,
  };
  await setSetting(deps.db, "reconcile_report", report);
  const remaining = providerRecords.filter((r) => !orphans.some((o) => o.id === r.id));
  await refreshZoneSnapshot(deps, remaining);
  const actionable = drift.filter((d) => d.kind !== "unmanaged").length;
  if (actionable > 5) {
    notifier.notify({
      key: "reconcile-drift",
      title: "對帳發現大量漂移",
      description: `本輪修正 ${actionable} 筆（missing / modified / orphan）。`,
      severity: "warning",
      url: `${config.APP_ORIGIN}/admin/zone`,
    });
  }
  return report;
}

export async function lastReconcileAt(deps: Pick<Deps, "db">): Promise<string | null> {
  const report = await getSetting(deps.db, "reconcile_report");
  return report?.at ?? null;
}
