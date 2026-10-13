/**
 * In-memory token bucket（replicas=1；擴充時改用 PG 計數或 Redis，PLAN §3.6）。
 * 每個 bucket 以 capacity 為上限，每 perMs 毫秒補滿 refill 個。
 */
export interface RateRule {
  scope: string;
  capacity: number;
  refill: number;
  perMs: number;
  by: "ip" | "user";
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const RULES = {
  global: { scope: "global", capacity: 300, refill: 300, perMs: MINUTE_MS, by: "ip" },
  availability: { scope: "availability", capacity: 20, refill: 60, perMs: MINUTE_MS, by: "ip" },
  auth: { scope: "auth", capacity: 20, refill: 20, perMs: MINUTE_MS, by: "ip" },
  createSubdomain: { scope: "create-subdomain", capacity: 5, refill: 5, perMs: DAY_MS, by: "user" },
  recordWriteMinute: {
    scope: "record-write-m",
    capacity: 10,
    refill: 10,
    perMs: MINUTE_MS,
    by: "user",
  },
  recordWriteHour: {
    scope: "record-write-h",
    capacity: 60,
    refill: 60,
    perMs: HOUR_MS,
    by: "user",
  },
  presetApply: { scope: "preset-apply", capacity: 20, refill: 20, perMs: HOUR_MS, by: "user" },
  propagation: { scope: "propagation", capacity: 12, refill: 12, perMs: MINUTE_MS, by: "user" },
  report: { scope: "report", capacity: 5, refill: 5, perMs: HOUR_MS, by: "ip" },
} as const satisfies Record<string, RateRule>;

export const RECORD_WRITE_RULES = [RULES.recordWriteMinute, RULES.recordWriteHour] as const;
export const EVENTS_MAX_CONNECTIONS = 5;

interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;
  #lastSweep = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** 扣一個 token；不夠時回傳需要等待的秒數 */
  take(rule: RateRule, key: string): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.#now();
    this.#sweep(now);
    const id = `${rule.scope}|${key}`;
    const rate = rule.refill / rule.perMs;
    const bucket = this.#buckets.get(id) ?? { tokens: rule.capacity, updated: now };
    bucket.tokens = Math.min(rule.capacity, bucket.tokens + (now - bucket.updated) * rate);
    bucket.updated = now;
    this.#buckets.set(id, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / rate / 1000)) };
  }

  /** 避免記憶體無限成長：每分鐘清掉已補滿的 bucket */
  #sweep(now: number): void {
    if (now - this.#lastSweep < MINUTE_MS) return;
    this.#lastSweep = now;
    for (const [id, bucket] of this.#buckets) {
      if (now - bucket.updated > DAY_MS) this.#buckets.delete(id);
    }
  }
}
