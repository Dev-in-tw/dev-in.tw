import { isApiError } from "./api/client.ts";
import { t } from "./i18n/zh-Hant.ts";

/** 給使用者看的錯誤訊息：優先用 problem.detail（後端給的繁中說明），否則依 code 對照 */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) return error.problem.detail ?? t.errors[error.code] ?? error.message;
  if (error instanceof TypeError) return "連不上伺服器，請檢查網路連線。";
  return t.errors.INTERNAL;
}

/** 把 problem.errors 依欄位路徑整理成 { address: "必須是公網位址" } */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!isApiError(error) || !error.problem.errors) return {};
  const out: Record<string, string> = {};
  for (const issue of error.problem.errors) {
    const key = issue.path.split(".").pop() || issue.path;
    out[key] ??= issue.message;
  }
  return out;
}
