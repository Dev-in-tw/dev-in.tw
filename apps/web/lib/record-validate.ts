import { type DnsRecord, RecordInput, type RecordType } from "@dit/contract";
import { isPublicIPv4, isPublicIPv6, validateRecord } from "@dit/dns";
import { type RecordDraft, toInput } from "./records.ts";

/**
 * 前端即時驗證。和後端用同一套規則：
 * 1. 合約的 zod schema（格式：IPv4/IPv6、主機名、TTL、數字範圍）
 * 2. `@dit/dns` 的 `validateRecord`、`isPublicIPv4/6`（CNAME 排他、私有 IP 等；由 WP-A 實作）
 * 錯誤訊息改寫成自然的繁中。後端回傳的 FieldIssue 仍是最終依據。
 */
export type FieldErrors = Partial<Record<keyof RecordDraft | "form", string>>;

const MESSAGES: Record<string, (type: RecordType) => string> = {
  address: (t) =>
    t === "A" ? "不是合法的 IPv4 位址，例如 185.199.108.153" : "不是合法的 IPv6 位址",
  target: () => "請填主機名，例如 you.github.io（不能是 IP）",
  exchange: () => "請填郵件主機名，例如 mx1.improvmx.com",
  value: (t) => (t === "TXT" ? "TXT 內容需要 1–2,048 個字元" : "請填 1–255 個字元"),
  priority: () => "優先序是 0–65535 的整數",
  weight: () => "權重是 0–65535 的整數",
  port: () => "埠號是 1–65535 的整數",
  flags: () => "旗標只能是 0 或 128",
  tag: () => "標籤只能是 issue、issuewild 或 iodef",
  name: () => "名稱只能用 @ 或英數、連字號，最多三層，例如 www 或 _acme-challenge",
  ttl: () => "TTL 是「自動」或 60–86400 秒",
};

export interface ValidateContext {
  sub: string;
  root: string;
  existing: readonly DnsRecord[];
  ownedSubdomains: readonly string[];
  allowedTypes: readonly RecordType[];
}

export function validateDraft(
  draft: RecordDraft,
  ctx: ValidateContext,
): { ok: true; input: RecordInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  if (!ctx.allowedTypes.includes(draft.type)) {
    errors.type = `目前不開放 ${draft.type} 紀錄`;
    return { ok: false, errors };
  }
  const parsed = RecordInput.safeParse(toInput(draft));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form") as keyof FieldErrors;
      if (!errors[key]) errors[key] = MESSAGES[key]?.(draft.type) ?? issue.message;
    }
    return { ok: false, errors };
  }
  const input = parsed.data;
  if (input.type === "A" && !isPublicIPv4(input.address)) {
    errors.address = `${input.address} 是私有或保留位址，外部無法連線`;
  }
  if (input.type === "AAAA" && !isPublicIPv6(input.address)) {
    errors.address = `${input.address} 不是公網 IPv6 位址`;
  }
  const verdict = validateRecord(input, ctx);
  if (!verdict.ok) {
    for (const v of verdict.violations) {
      const key = (v.path.split(".").pop() || "form") as keyof FieldErrors;
      errors[key] ??= v.message;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, input };
}

/** CNAME 與其他紀錄同名的即時提示（不阻擋送出，讓後端做最終判斷） */
export function cnameHint(
  draft: RecordDraft,
  existing: readonly DnsRecord[],
  editingId?: string,
): string | null {
  const name = draft.name.trim().toLowerCase() || "@";
  const same = existing.filter(
    (r) => r.name === name && r.id !== editingId && r.syncStatus !== "deleting",
  );
  if (draft.type === "CNAME" && same.length > 0) {
    return `${name} 已經有 ${same.map((r) => r.type).join("、")} 紀錄，CNAME 不能和其他紀錄同名`;
  }
  if (draft.type !== "CNAME" && same.some((r) => r.type === "CNAME")) {
    return `${name} 已經有 CNAME，不能再加其他類型的紀錄`;
  }
  return null;
}
