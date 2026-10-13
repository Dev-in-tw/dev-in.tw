import { ProviderError } from "../../sync/errors.ts";
import type { FetchLike } from "../http.ts";
import {
  type CloudflareApiError,
  classifyCloudflareError,
  classifyFetchException,
} from "./errors.ts";

export interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: CloudflareApiError[];
  result: T;
  result_info?: { page?: number; per_page?: number; total_pages?: number; total_count?: number };
}

export interface CloudflareClientOptions {
  apiToken: string;
  apiBase: string;
  fetch?: FetchLike;
  requestsPerSecond: number;
  timeoutMs: number;
  /** 測試用：注入時鐘與 sleep */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Client 端 token bucket：Cloudflare 全域限流是 1,200 req / 5 min（約 4 req/s），
 * 這裡控制在 requestsPerSecond（預設 3），容量 1 表示請求之間平均間隔 1/rps 秒。
 */
export class TokenBucket {
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #nextAt = 0;

  constructor(rps: number, now: () => number, sleep: (ms: number) => Promise<void>) {
    this.#intervalMs = 1000 / rps;
    this.#now = now;
    this.#sleep = sleep;
  }

  async take(): Promise<void> {
    const now = this.#now();
    const at = Math.max(now, this.#nextAt);
    this.#nextAt = at + this.#intervalMs;
    const wait = at - now;
    if (wait > 0) await this.#sleep(wait);
  }
}

export class CloudflareClient {
  readonly #opts: CloudflareClientOptions;
  readonly #fetch: FetchLike;
  readonly #bucket: TokenBucket;

  constructor(opts: CloudflareClientOptions) {
    this.#opts = opts;
    this.#fetch = opts.fetch ?? fetch;
    this.#bucket = new TokenBucket(
      opts.requestsPerSecond,
      opts.now ?? Date.now,
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    );
  }

  /** 回傳整個 envelope（分頁需要 result_info）；非成功時丟出分類後的 ProviderError */
  async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<CloudflareEnvelope<T>> {
    await this.#bucket.take();
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.#opts.apiToken}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await this.#fetch(`${this.#opts.apiBase.replace(/\/+$/, "")}${path}`, init);
    } catch (error) {
      throw classifyFetchException(error);
    }

    let envelope: CloudflareEnvelope<T> | null = null;
    try {
      envelope = (await res.json()) as CloudflareEnvelope<T>;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw classifyFetchException(error);
      }
      envelope = null;
    }

    if (!res.ok || !envelope || envelope.success !== true) {
      const errors = Array.isArray(envelope?.errors) ? envelope.errors : [];
      throw classifyCloudflareError(res.ok && !envelope ? 502 : res.status, errors);
    }
    return envelope;
  }
}

export const isNotFound = (e: unknown): boolean =>
  e instanceof ProviderError && e.kind === "not_found";
