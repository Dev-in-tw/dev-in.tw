import { MIDNIGHT_MARGIN_MS, nextUtcMidnight } from "../../sync/change-budget.ts";
import { ProviderError, type ProviderIssue } from "../../sync/errors.ts";

/**
 * Lazco DNS 錯誤分類（PLAN §3.8.1）。Dev-in 呼叫的是 Lazco Cloud 的公開 API（cloud-backend
 * `src/api/dns.ts`），錯誤 envelope 是 `{ error, code, timestamp, message?, issues?, version? }`，
 * dns-api 的錯誤碼原樣轉出來（`rethrowDnsError`）。一律依 `code` 分支，上游的原文不外傳。
 */

export interface LazcoErrorBody {
  error?: string;
  code?: string;
  message?: string;
  issues?: unknown;
  version?: number;
}

/** 這些錯誤代表「重新讀 zone、重新規劃再送一次」就好，不是紀錄本身的問題 */
export const REPLAN_CODES = new Set([
  "lazco:DNS_VERSION_MISMATCH",
  "lazco:DNS_CHANGE_IN_PROGRESS",
  "lazco:DNS_OUTCOME_UNKNOWN",
  "timeout",
  "network",
]);

/** zone 已經放不下（RRset 數或大小上限）：走「zone 滿了」的容量路徑 */
const ZONE_FULL = new Set(["DNS_RRSET_LIMIT_REACHED", "DNS_ZONE_SIZE_LIMIT_REACHED"]);

const CONFLICT = new Set([
  "DNS_CNAME_CONFLICT",
  "DNS_DUPLICATE_RECORD",
  "DNS_DUPLICATE_RRSET",
  "DNS_DELEGATION_CONFLICT",
  "DNS_DNAME_CONFLICT",
]);

const MSG = {
  auth: "DNS 服務認證失敗，系統管理員已收到通知",
  suspended: "DNS zone 已被 DNS 服務暫停，系統管理員已收到通知",
  capacity: "zone 的 RRset 數已達上限",
  daily: "今天的 DNS 變更批次額度已用完，會在下一個 UTC 日自動繼續",
  rateLimited: "DNS 服務暫時限制寫入頻率，系統會自動重試",
  conflict: "和 DNS 上同名的其他紀錄衝突",
  invalid: "DNS 服務拒絕了這筆紀錄的內容",
  notFound: "DNS 服務上找不到這個 zone",
  inProgress: "DNS zone 正在套用其他變更，系統會自動重試",
  versionMismatch: "DNS zone 剛被其他人修改，系統會重新讀取後再試",
  outcomeUnknown: "DNS 服務沒有及時回應，系統會重新讀取 zone 確認",
  transient: "DNS 服務暫時無法使用，系統會自動重試",
  timeout: "DNS 服務回應逾時，系統會自動重試",
  network: "DNS 服務暫時無法連線，系統會自動重試",
} as const;

/** Retry-After（秒數）；沒有或格式不對時用 fallback */
export function parseRetryAfter(raw: string | null | undefined, fallbackSeconds: number): number {
  if (raw === null || raw === undefined || raw.trim() === "") return fallbackSeconds;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : fallbackSeconds;
}

/** 422 的 issues：`[{ index, code, message }]`，index 是批次內第幾個變更（-1 是整批） */
function readIssues(raw: unknown, keyOfIndex: (index: number) => string | null): ProviderIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const { index, code, message } = item as { index?: unknown; code?: unknown; message?: unknown };
    return [
      {
        key: typeof index === "number" && index >= 0 ? keyOfIndex(index) : null,
        code: typeof code === "string" ? code : "UNKNOWN",
        message: typeof message === "string" ? message.slice(0, 300) : "",
      },
    ];
  });
}

export function classifyLazcoError(
  status: number,
  body: LazcoErrorBody | null,
  retryAfter: string | null,
  now: Date,
  keyOfIndex: (index: number) => string | null = () => null,
): ProviderError {
  const code = typeof body?.code === "string" ? body.code : null;
  const providerCode = code ? `lazco:${code}` : `http:${status}`;
  const err = (
    kind: ConstructorParameters<typeof ProviderError>[0],
    message: string,
    details?: ConstructorParameters<typeof ProviderError>[4],
  ) => new ProviderError(kind, providerCode, message, status, details);

  if (status === 401) return err("auth", MSG.auth);
  // 403：token 失效或範圍不含這個 zone、SESSION_REQUIRED、KYC_REQUIRED、FEATURE_DISABLED、
  // DNS_ZONE_SUSPENDED（被 operator 暫停）。都需要人處理，暫停 worker 並通知。
  if (status === 403) return err("auth", code === "DNS_ZONE_SUSPENDED" ? MSG.suspended : MSG.auth);
  if (status === 404) return err("not_found", MSG.notFound);
  if (status === 409) {
    return err("transient", code === "DNS_CHANGE_IN_PROGRESS" ? MSG.inProgress : MSG.transient);
  }
  if (status === 412) return err("transient", MSG.versionMismatch);
  // 428：沒有帶 If-Match。是 Dev-in 的錯，重試直到 dead 讓管理員看到
  if (status === 428) return err("transient", MSG.transient);
  if (status === 429) {
    if (code === "DNS_DAILY_CHANGE_LIMIT") {
      return err("capacity", MSG.daily, {
        retryAt: new Date(nextUtcMidnight(now).getTime() + MIDNIGHT_MARGIN_MS),
      });
    }
    // 組織每小時的寫入限流（cloud-backend `dns_write`），Retry-After 最長 3600 秒
    const seconds = Math.min(3600, parseRetryAfter(retryAfter, 60));
    return err("transient", MSG.rateLimited, { retryAt: new Date(now.getTime() + seconds * 1000) });
  }
  if (status === 422 || status === 400) {
    const issues = readIssues(body?.issues, keyOfIndex);
    const codes = new Set([code, ...issues.map((i) => i.code)]);
    if ([...codes].some((c) => c !== null && ZONE_FULL.has(c))) {
      return err("capacity", MSG.capacity, { issues });
    }
    const conflict = [...codes].some((c) => c !== null && CONFLICT.has(c));
    return err("permanent", conflict ? MSG.conflict : MSG.invalid, { issues });
  }
  if (status === 504 && code === "DNS_OUTCOME_UNKNOWN") return err("transient", MSG.outcomeUnknown);
  return err("transient", MSG.transient);
}

/** fetch 本身丟出的例外（逾時、連線錯誤） */
export function classifyLazcoException(error: unknown): ProviderError {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new ProviderError("transient", "timeout", MSG.timeout);
  }
  return new ProviderError("transient", "network", MSG.network);
}
