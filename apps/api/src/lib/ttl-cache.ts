/** 小型 TTL 快取（傳播檢查結果快取 15 秒等）。超過上限時先淘汰最舊的項目。 */
export class TtlCache<V> {
  readonly #entries = new Map<string, { value: V; expires: number }>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(ttlMs: number, max = 1000, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#max = max;
    this.#now = now;
  }

  get(key: string): V | undefined {
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    if (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, { value, expires: this.#now() + this.#ttlMs });
  }
}
