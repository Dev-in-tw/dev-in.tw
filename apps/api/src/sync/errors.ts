/**
 * Provider 錯誤分類（PLAN §3.8 錯誤分類表）。adapter 負責把上游錯誤轉成這個型別，
 * worker 只依 kind 決定重試、標記錯誤或暫停。message 是可以給使用者看的繁中說明，不含上游原文。
 */
export type ProviderErrorKind = "permanent" | "capacity" | "transient" | "auth" | "not_found";

/** 整批寫入被拒絕時，provider 指出的是哪一個變更（Lazco DNS 422 的 `issues[].index`，已換成 RRset key） */
export interface ProviderIssue {
  /** `<fqdn>|<type>`；整批層級的問題（例如 RRset 上限）是 null */
  key: string | null;
  code: string;
  message: string;
}

export interface ProviderErrorDetails {
  /**
   * 有值時代表「這個時間之前不要再試」（Lazco DNS 每日批次上限、限流的 Retry-After）：worker 把工作
   * 延到這個時間、不計入重試次數，也不把紀錄標成錯誤。
   */
  retryAt?: Date;
  issues?: readonly ProviderIssue[];
}

export class ProviderError extends Error {
  override name = "ProviderError";
  readonly kind: ProviderErrorKind;
  /** 例如 "cf:81053"、"http:503"、"timeout"、"lazco:DNS_DAILY_CHANGE_LIMIT" */
  readonly providerCode: string;
  readonly httpStatus: number | null;
  readonly retryAt: Date | null;
  readonly issues: readonly ProviderIssue[];

  constructor(
    kind: ProviderErrorKind,
    providerCode: string,
    message: string,
    httpStatus: number | null = null,
    details: ProviderErrorDetails = {},
  ) {
    super(message);
    this.kind = kind;
    this.providerCode = providerCode;
    this.httpStatus = httpStatus;
    this.retryAt = details.retryAt ?? null;
    this.issues = details.issues ?? [];
  }
}

export const isProviderError = (e: unknown): e is ProviderError => e instanceof ProviderError;

/** 非 ProviderError 的例外（網路中斷等）一律視為暫時錯誤 */
export function asProviderError(e: unknown): ProviderError {
  if (isProviderError(e)) return e;
  return new ProviderError("transient", "exception", "DNS 服務暫時無法連線，系統會自動重試");
}
