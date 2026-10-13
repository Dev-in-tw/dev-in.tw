/**
 * Provider 錯誤分類（PLAN §3.8 錯誤分類表）。adapter 負責把上游錯誤轉成這個型別，
 * worker 只依 kind 決定重試、標記錯誤或暫停。message 是可以給使用者看的繁中說明，不含上游原文。
 */
export type ProviderErrorKind = "permanent" | "capacity" | "transient" | "auth" | "not_found";

export class ProviderError extends Error {
  override name = "ProviderError";
  readonly kind: ProviderErrorKind;
  /** 例如 "cf:81053"、"http:503"、"timeout" */
  readonly providerCode: string;
  readonly httpStatus: number | null;

  constructor(
    kind: ProviderErrorKind,
    providerCode: string,
    message: string,
    httpStatus: number | null = null,
  ) {
    super(message);
    this.kind = kind;
    this.providerCode = providerCode;
    this.httpStatus = httpStatus;
  }
}

export const isProviderError = (e: unknown): e is ProviderError => e instanceof ProviderError;

/** 非 ProviderError 的例外（網路中斷等）一律視為暫時錯誤 */
export function asProviderError(e: unknown): ProviderError {
  if (isProviderError(e)) return e;
  return new ProviderError("transient", "exception", "DNS 服務暫時無法連線，系統會自動重試");
}
