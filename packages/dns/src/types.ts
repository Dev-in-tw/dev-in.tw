/** code 對應合約的 FieldIssue.code；能對應到 ErrorCode 時就用 ErrorCode（API 取第一個 violation 的 code） */
export type Violation = { path: string; code: string; message: string };
export type Verdict = { ok: true } | { ok: false; violations: Violation[] };

export const OK: Verdict = { ok: true };

/** 把 violation 清單轉成 Verdict：空清單就是 OK */
export function verdictOf(violations: readonly Violation[]): Verdict {
  return violations.length === 0 ? OK : { ok: false, violations: [...violations] };
}
