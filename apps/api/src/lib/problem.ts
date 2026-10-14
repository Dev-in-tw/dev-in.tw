import {
  ERROR_STATUS,
  type ErrorCode,
  type FieldIssue,
  type Problem,
  problemType,
} from "@dit/contract";

const TITLES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: "Request validation failed",
  NOT_FOUND: "Not found",
  UNAUTHENTICATED: "Authentication required",
  FORBIDDEN: "Forbidden",
  CSRF_REJECTED: "Cross-site request rejected",
  RATE_LIMITED: "Too many requests",
  VERSION_CONFLICT: "Resource version mismatch",
  IDEMPOTENCY_KEY_REUSED: "Idempotency key reused",
  NOT_IMPLEMENTED: "Not implemented",
  INTERNAL: "Internal server error",
  ACCOUNT_SUSPENDED: "Account suspended",
  REGISTRATION_CLOSED: "Registration closed",
  TURNSTILE_FAILED: "Turnstile verification failed",
  CONFIRMATION_MISMATCH: "Confirmation does not match",
  CONSENT_REQUIRED: "Consent to the current terms is required",
  NAME_INVALID: "Name is invalid",
  NAME_RESERVED: "Name is reserved",
  NAME_TAKEN: "Name is taken",
  NAME_COOLDOWN: "Name is cooling down",
  SUBDOMAIN_QUOTA_EXCEEDED: "Subdomain quota exceeded",
  ZONE_CAPACITY_EXHAUSTED: "Zone capacity exhausted",
  SUBDOMAIN_NOT_ACTIVE: "Subdomain is not active",
  RECORD_QUOTA_EXCEEDED: "Record quota exceeded",
  RECORD_CONFLICT: "Record conflicts with an existing record",
  RECORD_DUPLICATE: "Duplicate record",
  RECORD_TYPE_NOT_ALLOWED: "Record type not allowed",
  RECORD_TARGET_NOT_ALLOWED: "Record target not allowed",
  IP_NOT_PUBLIC: "Address is not public",
  PRESET_PARAMS_INVALID: "Preset parameters invalid",
  TRANSFER_RECIPIENT_NOT_FOUND: "Transfer recipient not found",
  TRANSFER_RECIPIENT_QUOTA: "Transfer recipient over quota",
  TRANSFER_INVALID_STATE: "Transfer is not in a valid state",
  TRANSFER_ALREADY_PENDING: "Transfer already pending",
  UPSTREAM_DNS_ERROR: "DNS provider error",
  UPSTREAM_GITHUB_ERROR: "GitHub error",
};

const DEFAULT_DETAIL: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: "請求內容不正確",
  NOT_FOUND: "找不到這個資源",
  UNAUTHENTICATED: "請先登入",
  CSRF_REJECTED: "請求來源不正確，請重新整理頁面後再試一次",
  RATE_LIMITED: "請求太頻繁，請稍後再試",
  NOT_IMPLEMENTED: "這個功能即將推出",
  INTERNAL: "系統發生錯誤，請稍後再試",
  ACCOUNT_SUSPENDED: "帳號已被停權",
  UPSTREAM_DNS_ERROR: "DNS 服務暫時無法使用，請稍後再試",
  UPSTREAM_GITHUB_ERROR: "GitHub 暫時無法使用，請稍後再試",
};

export interface AppErrorOptions {
  errors?: FieldIssue[];
  retryAfter?: number;
  headers?: Record<string, string>;
}

/** 可預期的業務錯誤；problem 中介層會轉成 RFC 9457 problem+json。 */
export class AppError extends Error {
  override name = "AppError";
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  readonly options: AppErrorOptions;

  constructor(code: ErrorCode, detail?: string, options: AppErrorOptions = {}) {
    super(detail ?? code);
    this.code = code;
    this.detail = detail;
    this.options = options;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export const isErrorCode = (code: string): code is ErrorCode => code in ERROR_STATUS;

export function toProblem(
  code: ErrorCode,
  input: { detail?: string | undefined; instance?: string; requestId: string } & AppErrorOptions,
): Problem {
  const detail = input.detail ?? DEFAULT_DETAIL[code];
  return {
    type: problemType(code),
    title: TITLES[code],
    status: ERROR_STATUS[code],
    code,
    ...(detail !== undefined ? { detail } : {}),
    ...(input.instance !== undefined ? { instance: input.instance } : {}),
    requestId: input.requestId,
    ...(input.errors && input.errors.length > 0 ? { errors: input.errors } : {}),
    ...(input.retryAfter !== undefined ? { retryAfter: input.retryAfter } : {}),
  };
}
