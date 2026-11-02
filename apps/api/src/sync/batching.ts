import type { DnsRecord, SyncBatching } from "@dit/contract";
import { and, inArray, min } from "drizzle-orm";
import type { Deps } from "../context.ts";
import { dnsSyncJobs } from "../db/schema.ts";
import { SECOND } from "../lib/clock.ts";
import { type BatchSchedule, batchSchedule } from "./change-budget.ts";
import type { RrsetWriter } from "./provider-port.ts";

/** 最後一筆變更後安靜這麼久才送出，讓連續幾次編輯併成一批 */
export const BATCH_QUIET_MS = 10 * SECOND;
/** 但最早的一筆最多只等這麼久（持續有人在改時也會送） */
export const BATCH_MAX_WAIT_MS = 60 * SECOND;

/**
 * 目前的批次排程；provider 不是批次寫入時回 null。
 *
 * worker 要傳入它自己的 now：排程的 nextAt 是 max(now, 上一批＋間隔)，閒置之後就等於 now。
 * 如果這裡再讀一次時鐘，nextAt 會比 worker 的 now 晚幾毫秒，`nextAt > now` 永遠成立，這一批永遠送不出去
 * （2026-11-02 在 prod 發生；測試的 ManualClock 不會前進，所以測不出來）。
 */
export async function currentSchedule(
  deps: Pick<Deps, "provider" | "config" | "clock">,
  writer: RrsetWriter | undefined = deps.provider.rrsets,
  now: Date = deps.clock.now(),
): Promise<BatchSchedule | null> {
  if (!writer) return null;
  return batchSchedule(
    now,
    await writer.budget.state(now),
    writer.budget.dailyBudget,
    deps.config.LAZCO_DNS_MIN_BATCH_INTERVAL_SECONDS * SECOND,
  );
}

export function toSyncBatching(schedule: BatchSchedule): SyncBatching {
  return {
    intervalSeconds: Math.round(schedule.intervalMs / SECOND),
    nextBatchAt: schedule.nextAt.toISOString(),
    lastBatchAt: schedule.lastBatchAt?.toISOString() ?? null,
    pausedUntil: schedule.pausedUntil?.toISOString() ?? null,
    batchesToday: schedule.usedToday,
    dailyBudget: schedule.dailyBudget,
  };
}

/** `/status`、`/admin/zone` 用；讀不到額度時（DB 有問題）回 null，不讓狀態頁失敗 */
export async function batchingStatus(
  deps: Pick<Deps, "provider" | "config" | "clock" | "logger">,
): Promise<SyncBatching | null> {
  try {
    const schedule = await currentSchedule(deps);
    return schedule ? toSyncBatching(schedule) : null;
  } catch (error) {
    deps.logger.warn({ err: error }, "reading the dns batch schedule failed");
    return null;
  }
}

/**
 * 現在排入的變更預計何時寫入 DNS：下一批的時間（至少再等一個安靜期）。provider 即時同步時回 null。
 * runAt 是工作本身的執行時間（退避中的工作比下一批晚）。
 */
export function etaFrom(
  schedule: BatchSchedule | null,
  now: Date,
  runAt: Date | null = null,
): string | null {
  if (!schedule) return null;
  const at = Math.max(
    schedule.nextAt.getTime(),
    now.getTime() + BATCH_QUIET_MS,
    runAt?.getTime() ?? 0,
  );
  return new Date(at).toISOString();
}

export async function syncEta(
  deps: Pick<Deps, "provider" | "config" | "clock" | "logger">,
): Promise<string | null> {
  try {
    return etaFrom(await currentSchedule(deps), deps.clock.now());
  } catch (error) {
    deps.logger.warn({ err: error }, "reading the dns batch schedule failed");
    return null;
  }
}

const waiting = (r: DnsRecord) => r.syncStatus === "pending" || r.syncStatus === "deleting";

/**
 * 批次模式時替 pending／deleting 的紀錄補上 syncEta（下一批的時間，退避中的工作取它自己的 run_at）。
 * 即時同步的 provider 不加這個欄位，回應和以前完全相同。
 */
export async function withSyncEtas<T extends DnsRecord>(
  deps: Pick<Deps, "provider" | "config" | "clock" | "logger" | "db">,
  items: T[],
): Promise<T[]> {
  if (!deps.provider.rrsets || !items.some(waiting)) return items;
  let schedule: BatchSchedule | null;
  let runAt = new Map<string, Date>();
  try {
    schedule = await currentSchedule(deps);
    const ids = items.filter(waiting).map((r) => r.id);
    const rows = await deps.db
      .select({ id: dnsSyncJobs.recordId, runAt: min(dnsSyncJobs.runAt) })
      .from(dnsSyncJobs)
      .where(and(inArray(dnsSyncJobs.recordId, ids), inArray(dnsSyncJobs.status, ["queued"])))
      .groupBy(dnsSyncJobs.recordId);
    runAt = new Map(rows.flatMap((r) => (r.id && r.runAt ? [[r.id, new Date(r.runAt)]] : [])));
  } catch (error) {
    deps.logger.warn({ err: error }, "reading the dns batch schedule failed");
    return items;
  }
  const now = deps.clock.now();
  return items.map((r) =>
    waiting(r) ? { ...r, syncEta: etaFrom(schedule, now, runAt.get(r.id) ?? null) } : r,
  );
}

export async function withSyncEta<T extends DnsRecord>(
  deps: Pick<Deps, "provider" | "config" | "clock" | "logger" | "db">,
  item: T,
): Promise<T> {
  const [out] = await withSyncEtas(deps, [item]);
  return out ?? item;
}
