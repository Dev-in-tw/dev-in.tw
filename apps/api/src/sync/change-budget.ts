import { sql } from "drizzle-orm";
import { type Executor, ts } from "../db/client.ts";
import { DAY } from "../lib/clock.ts";
import type { ChangeBudget } from "./provider-port.ts";

/** UTC 日期（YYYY-MM-DD）：Lazco DNS 的每日上限從 UTC 0 點起算 */
export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/** 下一個 UTC 0 點 */
export const nextUtcMidnight = (now: Date): Date =>
  new Date(Math.floor(now.getTime() / DAY) * DAY + DAY);

/**
 * 每日批次額度，存在 dns_change_budget（每個 zone、每個 UTC 日一列）。每次 PATCH 之前呼叫 take()：
 * 以單一 upsert 原子遞增，用量到 dailyBudget 時不再遞增並回傳 false。reconciler 與 worker 共用同一份額度。
 *
 * 保守計算：Lazco DNS 實際上只把「進到 PowerDNS 的變更」算進上限（412、409、驗證錯誤不算），這裡每送出
 * 一次 PATCH 就算一次，所以真正的用量只會比這裡少。
 */
export class PgChangeBudget implements ChangeBudget {
  readonly dailyBudget: number;
  readonly #db: Executor;
  readonly #zone: string;

  constructor(db: Executor, zone: string, dailyBudget: number) {
    this.#db = db;
    this.#zone = zone;
    this.dailyBudget = dailyBudget;
  }

  async take(now: Date): Promise<boolean> {
    const rows = await this.#db.execute(sql`
      insert into dns_change_budget as b (zone, day, used, last_batch_at)
      values (${this.#zone}, ${utcDay(now)}::date, 1, ${ts(now)})
      on conflict (zone, day) do update
        set used = b.used + 1, last_batch_at = excluded.last_batch_at
        where b.used < ${this.dailyBudget}
      returning b.used`);
    return rows.length > 0 && this.dailyBudget >= 1;
  }

  async exhaust(now: Date): Promise<void> {
    await this.#db.execute(sql`
      insert into dns_change_budget as b (zone, day, used)
      values (${this.#zone}, ${utcDay(now)}::date, ${this.dailyBudget})
      on conflict (zone, day) do update set used = greatest(b.used, excluded.used)`);
  }

  async state(now: Date): Promise<{ usedToday: number; lastBatchAt: Date | null }> {
    const [row] = await this.#db.execute<{ used: number | null; last: Date | string | null }>(sql`
      select (select used from dns_change_budget where zone = ${this.#zone} and day = ${utcDay(now)}::date) as used,
             (select max(last_batch_at) from dns_change_budget where zone = ${this.#zone}) as last`);
    return {
      usedToday: Number(row?.used ?? 0),
      lastBatchAt: row?.last ? new Date(row.last) : null,
    };
  }
}

export interface BatchSchedule {
  /** 兩批之間目前的最短間隔：今天剩下的時間 ÷ 剩下的額度，至少 minIntervalMs */
  intervalMs: number;
  /** 下一批最早可以送出的時間 */
  nextAt: Date;
  lastBatchAt: Date | null;
  /** 今天的額度已用完：暫停到下一個 UTC 日（加一點緩衝） */
  pausedUntil: Date | null;
  usedToday: number;
  dailyBudget: number;
}

/** 跨過 UTC 0 點後多等一下，避免和 Lazco DNS 的時鐘差幾秒就又撞到上限 */
export const MIDNIGHT_MARGIN_MS = 60_000;

/**
 * 依今天的用量排定下一批：把剩下的額度平均分配到今天剩下的時間，所以額度永遠不會在 UTC 0 點前用完。
 * 一天開始時（80 批、24 小時）約每 18 分鐘一批；前半天沒什麼變更時，後半天的間隔會縮短。
 */
export function batchSchedule(
  now: Date,
  state: { usedToday: number; lastBatchAt: Date | null },
  dailyBudget: number,
  minIntervalMs: number,
): BatchSchedule {
  const midnight = nextUtcMidnight(now);
  const remaining = dailyBudget - state.usedToday;
  if (remaining <= 0) {
    const pausedUntil = new Date(midnight.getTime() + MIDNIGHT_MARGIN_MS);
    return {
      intervalMs: Math.max(minIntervalMs, Math.floor(DAY / Math.max(1, dailyBudget))),
      nextAt: pausedUntil,
      lastBatchAt: state.lastBatchAt,
      pausedUntil,
      usedToday: state.usedToday,
      dailyBudget,
    };
  }
  const intervalMs = Math.max(
    minIntervalMs,
    Math.floor((midnight.getTime() - now.getTime()) / remaining),
  );
  const earliest = state.lastBatchAt ? state.lastBatchAt.getTime() + intervalMs : now.getTime();
  return {
    intervalMs,
    nextAt: new Date(Math.max(now.getTime(), earliest)),
    lastBatchAt: state.lastBatchAt,
    pausedUntil: null,
    usedToday: state.usedToday,
    dailyBudget,
  };
}
