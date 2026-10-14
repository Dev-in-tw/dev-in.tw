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
  /** 轉移邀請會通知對方，也能用來試探某個 GitHub 帳號有沒有用過本站 */
  transfer: { scope: "transfer", capacity: 10, refill: 10, perMs: HOUR_MS, by: "user" },
  consent: { scope: "consent", capacity: 10, refill: 10, perMs: HOUR_MS, by: "user" },
} as const satisfies Record<string, RateRule>;

export const RECORD_WRITE_RULES = [RULES.recordWriteMinute, RULES.recordWriteHour] as const;
/** SSE（GET /events）：每個使用者、每個來源 IP（IPv6 以 /64 計）與整個 process 的同時連線上限 */
export const EVENTS_MAX_CONNECTIONS = 5;
export const EVENTS_MAX_PER_IP = 20;
export const EVENTS_MAX_TOTAL = 1000;
/** bucket 數量的硬上限：超過時先清掉已補滿的，再淘汰最久沒用到的 */
export const MAX_BUCKETS = 100_000;

interface Bucket {
  tokens: number;
  updated: number;
  capacity: number;
  rate: number;
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;
  readonly #enabled: boolean;
  readonly #maxBuckets: number;
  #lastSweep = 0;

  constructor(now: () => number = Date.now, opts: { enabled?: boolean; maxBuckets?: number } = {}) {
    this.#now = now;
    this.#enabled = opts.enabled ?? true;
    this.#maxBuckets = opts.maxBuckets ?? MAX_BUCKETS;
  }

  /** 目前保存的 bucket 數（測試與監控用） */
  get size(): number {
    return this.#buckets.size;
  }

  /** 扣一個 token；不夠時回傳需要等待的秒數 */
  take(rule: RateRule, key: string): { ok: true } | { ok: false; retryAfter: number } {
    if (!this.#enabled) return { ok: true };
    const now = this.#now();
    this.#sweep(now);
    const id = `${rule.scope}|${key}`;
    const rate = rule.refill / rule.perMs;
    const existing = this.#buckets.get(id);
    const bucket = existing ?? {
      tokens: rule.capacity,
      updated: now,
      capacity: rule.capacity,
      rate,
    };
    bucket.tokens = Math.min(rule.capacity, bucket.tokens + (now - bucket.updated) * rate);
    bucket.updated = now;
    // 重新插入讓 Map 的順序等於最近使用順序（淘汰時從最舊的開始）
    if (existing) this.#buckets.delete(id);
    else if (this.#buckets.size >= this.#maxBuckets) this.#evict(now);
    this.#buckets.set(id, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / rate / 1000)) };
  }

  /** 已經補滿的 bucket 和不存在沒有差別，可以直接丟掉 */
  #isFull(bucket: Bucket, now: number): boolean {
    return bucket.tokens + (now - bucket.updated) * bucket.rate >= bucket.capacity;
  }

  /** 避免記憶體無限成長：每分鐘清掉已補滿的 bucket */
  #sweep(now: number): void {
    if (now - this.#lastSweep < MINUTE_MS) return;
    this.#lastSweep = now;
    for (const [id, bucket] of this.#buckets) {
      if (this.#isFull(bucket, now)) this.#buckets.delete(id);
    }
  }

  /** 到達上限：先清掉補滿的；還是太多就淘汰最久沒用到的十分之一 */
  #evict(now: number): void {
    for (const [id, bucket] of this.#buckets) {
      if (this.#isFull(bucket, now)) this.#buckets.delete(id);
    }
    if (this.#buckets.size < this.#maxBuckets) return;
    let drop = Math.max(1, Math.floor(this.#maxBuckets / 10));
    for (const id of this.#buckets.keys()) {
      if (drop-- <= 0) break;
      this.#buckets.delete(id);
    }
  }
}
