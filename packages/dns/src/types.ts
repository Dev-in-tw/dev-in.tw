/** code 對應合約的 FieldIssue.code */
export type Violation = { path: string; code: string; message: string };
export type Verdict = { ok: true } | { ok: false; violations: Violation[] };

export const OK: Verdict = { ok: true };
