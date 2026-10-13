import { ProviderError } from "../../sync/errors.ts";

/**
 * Cloudflare 錯誤分類（PLAN §3.8，比照 Lazco `rethrow<Domain>Error`）。
 * 上游的錯誤原文絕不往外傳，只保留 `cf:<code>` / `http:<status>` 與固定的繁中訊息。
 */

export interface CloudflareApiError {
  code: number;
  message?: string;
}

const AUTH_CODES = new Set([9103, 9106, 9109, 10000]);
const CAPACITY_CODES = new Set([81045]);
const CONFLICT_CODES = new Set([81053, 81054, 81055, 81056, 81057, 81058]);
const NOT_FOUND_CODES = new Set([81044]);

const MSG = {
  auth: "DNS 服務認證失敗，系統管理員已收到通知",
  capacity: "zone 紀錄數已達上限",
  conflict: "同名已有紀錄，與 CNAME 衝突",
  invalid: "DNS 服務拒絕了這筆紀錄的內容",
  notFound: "DNS 服務上找不到這筆紀錄",
  transient: "DNS 服務暫時無法使用，系統會自動重試",
  timeout: "DNS 服務回應逾時，系統會自動重試",
  network: "DNS 服務暫時無法連線，系統會自動重試",
} as const;

/** 依 HTTP 狀態與 CF envelope 的 errors 分類 */
export function classifyCloudflareError(
  status: number,
  errors: readonly CloudflareApiError[],
): ProviderError {
  const codes = errors.map((e) => e.code).filter((c) => Number.isInteger(c));
  const first = codes[0];
  const code = (fallback: string) => (first !== undefined ? `cf:${first}` : fallback);

  if (status === 401 || status === 403 || codes.some((c) => AUTH_CODES.has(c))) {
    const c = codes.find((x) => AUTH_CODES.has(x));
    return new ProviderError(
      "auth",
      c !== undefined ? `cf:${c}` : `http:${status}`,
      MSG.auth,
      status,
    );
  }
  const capacity = codes.find((c) => CAPACITY_CODES.has(c));
  if (capacity !== undefined) {
    return new ProviderError("capacity", `cf:${capacity}`, MSG.capacity, status);
  }
  const conflict = codes.find((c) => CONFLICT_CODES.has(c));
  if (conflict !== undefined) {
    return new ProviderError("permanent", `cf:${conflict}`, MSG.conflict, status);
  }
  const notFound = codes.find((c) => NOT_FOUND_CODES.has(c));
  if (status === 404 || notFound !== undefined) {
    return new ProviderError(
      "not_found",
      notFound !== undefined ? `cf:${notFound}` : `http:${status}`,
      MSG.notFound,
      status,
    );
  }
  if (status === 429 || status >= 500) {
    return new ProviderError("transient", `http:${status}`, MSG.transient, status);
  }
  if (status === 400 && codes.some((c) => c >= 1000 && c <= 9999)) {
    return new ProviderError("permanent", code(`http:${status}`), MSG.invalid, status);
  }
  if (status >= 400 && status < 500) {
    return new ProviderError("permanent", code(`http:${status}`), MSG.invalid, status);
  }
  // 2xx 但 success=false：不明狀態，當作暫時錯誤重試
  return new ProviderError("transient", code(`http:${status}`), MSG.transient, status);
}

/** fetch 本身丟出的例外（逾時、連線錯誤） */
export function classifyFetchException(error: unknown): ProviderError {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new ProviderError("transient", "timeout", MSG.timeout);
  }
  return new ProviderError("transient", "network", MSG.network);
}
