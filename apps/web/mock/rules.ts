/**
 * Mock 用的簡化規則。正式規則在 `packages/dns`（WP-A），這裡只做到讓前端的每種狀態都能被觸發：
 * 名稱格式、保留字、品牌近似、私有 IP、CNAME 排他、重複。
 */
import {
  type Availability,
  type DnsRecord,
  type FieldIssue,
  type RecordInput,
  SUBDOMAIN_LABEL_RE,
} from "@dit/contract";
import { ROOT_DOMAIN } from "@dit/contract/fixtures";
import {
  BRAND_NAMES,
  checkLabelSyntax,
  confusableWith,
  RESERVED_SEED,
  validateRecord,
} from "@dit/dns";
import { type MockUser, state, zoneUsed } from "./state.ts";

const RESERVED = new Map(RESERVED_SEED.map((r) => [r.name, r.category]));

function syntaxReason(name: string): string | null {
  if (
    !SUBDOMAIN_LABEL_RE.test(name) &&
    name.length >= 3 &&
    name.length <= 32 &&
    !name.includes("--")
  ) {
    return "只能使用小寫英文字母、數字與連字號";
  }
  const verdict = checkLabelSyntax(name);
  return verdict.ok ? null : (verdict.violations[0]?.message ?? "名稱格式不正確");
}

function suggest(name: string, login: string | null): string[] {
  const base = name
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const candidates = [`${base}-dev`, `${base}tw`, `${base}-tw`, `hi-${base}`];
  if (login) candidates.push(login.toLowerCase());
  return candidates
    .filter((c) => SUBDOMAIN_LABEL_RE.test(c) && c !== name)
    .filter((c) => quickStatus(c) === "available")
    .slice(0, 5);
}

function quickStatus(name: string): Availability["status"] {
  if (syntaxReason(name)) return "invalid";
  if (RESERVED.has(name)) return "reserved";
  if (state.subdomains.some((s) => s.name === name)) return "taken";
  if (state.holds.has(name)) return "cooldown";
  return "available";
}

export function availability(raw: string, viewer: MockUser | null): Availability {
  const name = raw.trim().toLowerCase();
  const fqdn = `${name}.${ROOT_DOMAIN}`;
  const base = { name, fqdn };
  const reason = syntaxReason(name);
  if (reason) return { ...base, status: "invalid", reason, suggestions: [] };
  const category = RESERVED.get(name);
  if (category) {
    return {
      ...base,
      status: "reserved",
      reason: category === "brand" ? "這是品牌保留名稱" : "這是系統保留的名稱",
      suggestions: suggest(name, viewer?.githubLogin ?? null),
    };
  }
  if (state.subdomains.some((s) => s.name === name)) {
    return {
      ...base,
      status: "taken",
      reason: "這個名稱已經有人使用",
      suggestions: suggest(name, viewer?.githubLogin ?? null),
    };
  }
  if (state.holds.has(name)) {
    return {
      ...base,
      status: "cooldown",
      reason: "這個名稱剛被釋出，冷卻期結束後才能申請",
      suggestions: suggest(name, viewer?.githubLogin ?? null),
    };
  }
  if (state.config.capacityFull || zoneUsed() >= 1000) {
    return {
      ...base,
      status: "capacity_full",
      reason: "目前名額已滿，請稍後再試",
      suggestions: [],
    };
  }
  const brand = confusableWith(name, BRAND_NAMES);
  if (brand) {
    return {
      ...base,
      status: "review",
      reason: "名稱和知名品牌相似，送出後需要人工審核",
      reviewReasons: [`confusable:${brand}`],
      suggestions: [],
    };
  }
  return { ...base, status: "available", suggestions: [] };
}

export interface RuleError {
  code:
    | "VALIDATION_FAILED"
    | "IP_NOT_PUBLIC"
    | "RECORD_CONFLICT"
    | "RECORD_DUPLICATE"
    | "RECORD_TYPE_NOT_ALLOWED"
    | "RECORD_TARGET_NOT_ALLOWED";
  detail: string;
  errors: FieldIssue[];
}

export const ALLOWED_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA"] as const;

export function dataOf(r: RecordInput): string {
  switch (r.type) {
    case "A":
    case "AAAA":
      return r.address;
    case "CNAME":
      return r.target;
    case "TXT":
      return r.value;
    case "MX":
      return `${r.priority} ${r.exchange}`;
    case "SRV":
      return `${r.priority} ${r.weight} ${r.port} ${r.target}`;
    case "CAA":
      return `${r.flags} ${r.tag} "${r.value}"`;
  }
}

const RULE_CODES = new Set<string>([
  "IP_NOT_PUBLIC",
  "RECORD_CONFLICT",
  "RECORD_DUPLICATE",
  "RECORD_TYPE_NOT_ALLOWED",
  "RECORD_TARGET_NOT_ALLOWED",
]);

/** 和後端一樣用 @dit/dns 的 validateRecord，第一個 violation 決定 Problem.code */
export function checkRecord(
  input: RecordInput,
  sub: string,
  existing: readonly DnsRecord[],
  ownedSubdomains: readonly string[],
): RuleError | null {
  const verdict = validateRecord(input, {
    sub,
    root: ROOT_DOMAIN,
    existing: existing.filter((r) => r.syncStatus !== "deleting"),
    ownedSubdomains,
    allowedTypes: ALLOWED_TYPES,
  });
  if (verdict.ok) return null;
  const first = verdict.violations[0];
  const code =
    first && RULE_CODES.has(first.code) ? (first.code as RuleError["code"]) : "VALIDATION_FAILED";
  return { code, detail: first?.message ?? "紀錄不符合規則", errors: verdict.violations };
}
