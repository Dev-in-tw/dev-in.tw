import { z } from "zod";

export const ErrorCode = z.enum([
  // 通用
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CSRF_REJECTED",
  "RATE_LIMITED",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_KEY_REUSED",
  "NOT_IMPLEMENTED",
  "INTERNAL",
  // 帳號
  "ACCOUNT_SUSPENDED",
  "REGISTRATION_CLOSED",
  "TURNSTILE_FAILED",
  "CONFIRMATION_MISMATCH",
  "CONSENT_REQUIRED",
  // 名稱與子網域
  "NAME_INVALID",
  "NAME_RESERVED",
  "NAME_TAKEN",
  "NAME_COOLDOWN",
  "SUBDOMAIN_QUOTA_EXCEEDED",
  "ZONE_CAPACITY_EXHAUSTED",
  "SUBDOMAIN_NOT_ACTIVE",
  // 紀錄
  "RECORD_QUOTA_EXCEEDED",
  "RECORD_CONFLICT",
  "RECORD_DUPLICATE",
  "RECORD_TYPE_NOT_ALLOWED",
  "RECORD_TARGET_NOT_ALLOWED",
  "IP_NOT_PUBLIC",
  "PRESET_PARAMS_INVALID",
  // 轉移與檢舉
  "TRANSFER_RECIPIENT_NOT_FOUND",
  "TRANSFER_RECIPIENT_QUOTA",
  "TRANSFER_INVALID_STATE",
  "TRANSFER_ALREADY_PENDING",
  // 上游
  "UPSTREAM_DNS_ERROR",
  "UPSTREAM_GITHUB_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * 每個錯誤碼對應的 HTTP 狀態碼（後端回應時使用；前端只依 `code` 判斷邏輯）。
 * 合約新增：§3.6 只散列了部分狀態碼，這裡集中成單一來源，避免前後端各自猜測。
 */
export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  RATE_LIMITED: 429,
  VERSION_CONFLICT: 412,
  IDEMPOTENCY_KEY_REUSED: 422,
  NOT_IMPLEMENTED: 501,
  INTERNAL: 500,
  ACCOUNT_SUSPENDED: 403,
  REGISTRATION_CLOSED: 403,
  TURNSTILE_FAILED: 400,
  CONFIRMATION_MISMATCH: 400,
  CONSENT_REQUIRED: 409,
  NAME_INVALID: 400,
  NAME_RESERVED: 409,
  NAME_TAKEN: 409,
  NAME_COOLDOWN: 409,
  SUBDOMAIN_QUOTA_EXCEEDED: 409,
  ZONE_CAPACITY_EXHAUSTED: 409,
  SUBDOMAIN_NOT_ACTIVE: 409,
  RECORD_QUOTA_EXCEEDED: 409,
  RECORD_CONFLICT: 409,
  RECORD_DUPLICATE: 409,
  RECORD_TYPE_NOT_ALLOWED: 400,
  RECORD_TARGET_NOT_ALLOWED: 400,
  IP_NOT_PUBLIC: 400,
  PRESET_PARAMS_INVALID: 400,
  TRANSFER_RECIPIENT_NOT_FOUND: 404,
  TRANSFER_RECIPIENT_QUOTA: 409,
  TRANSFER_INVALID_STATE: 409,
  TRANSFER_ALREADY_PENDING: 409,
  UPSTREAM_DNS_ERROR: 502,
  UPSTREAM_GITHUB_ERROR: 502,
} as const satisfies Record<ErrorCode, number>;

/** RFC 9457 `type` 欄位：`https://dev-in.tw/problems/<kebab-case code>` */
export function problemType(code: ErrorCode): string {
  return `https://dev-in.tw/problems/${code.toLowerCase().replaceAll("_", "-")}`;
}

export const FieldIssue = z.object({ path: z.string(), code: z.string(), message: z.string() });
export type FieldIssue = z.infer<typeof FieldIssue>;

/** RFC 9457 problem details，加上 code、requestId、errors 擴充欄位 */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int().min(400).max(599),
  code: ErrorCode,
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string(),
  errors: z.array(FieldIssue).optional(),
  retryAfter: z.int().optional(),
});
export type Problem = z.infer<typeof Problem>;
