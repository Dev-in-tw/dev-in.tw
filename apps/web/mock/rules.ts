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
import { RESERVED_SEED } from "@dit/dns";
import { type MockUser, state, zoneUsed } from "./state.ts";

const RESERVED = new Map(RESERVED_SEED.map((r) => [r.name, r.category]));
const BRANDS = RESERVED_SEED.filter((r) => r.category === "brand").map((r) => r.name);

export function leet(label: string): string {
  return label
    .replaceAll("-", "")
    .replaceAll("0", "o")
    .replaceAll("1", "l")
    .replaceAll("3", "e")
    .replaceAll("4", "a")
    .replaceAll("5", "s")
    .replaceAll("7", "t");
}

/** 長度 ≥ 5 的品牌才做 leet 與子字串比對（PLAN §3.9） */
export function confusable(label: string): string | null {
  const skeleton = leet(label);
  for (const brand of BRANDS) {
    if (brand.length < 5) continue;
    if (skeleton !== label.replaceAll("-", "") && skeleton.includes(brand)) return brand;
    if (label.includes(brand) && label !== brand) return brand;
  }
  return null;
}

function syntaxReason(name: string): string | null {
  if (name.length < 3) return "名稱至少要 3 個字元（1–2 字元的名稱保留中）";
  if (name.length > 32) return "名稱最多 32 個字元";
  if (name.includes("--")) return "名稱不可包含連續的連字號（--）";
  if (name.includes("_")) return "子網域名稱不能有底線";
  if (/^-|-$/.test(name)) return "名稱的開頭與結尾不能是連字號";
  if (!SUBDOMAIN_LABEL_RE.test(name)) return "只能使用小寫英文字母、數字與連字號";
  return null;
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
  const brand = confusable(name);
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

function ipv4Private(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  const [a = 0, b = 0, c = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Private(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  const first = Number.parseInt(lower.split(":")[0] || "0", 16);
  // 必須在 2000::/3 之內，且不是 2001:db8::/32
  if (first < 0x2000 || first > 0x3fff) return true;
  return lower.startsWith("2001:db8:") || lower.startsWith("2001:0db8:");
}

export interface RuleError {
  code:
    | "IP_NOT_PUBLIC"
    | "RECORD_CONFLICT"
    | "RECORD_DUPLICATE"
    | "RECORD_TYPE_NOT_ALLOWED"
    | "RECORD_TARGET_NOT_ALLOWED";
  detail: string;
  errors: FieldIssue[];
}

export const ALLOWED_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX"] as const;

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

export function checkRecord(
  input: RecordInput,
  sub: string,
  existing: readonly DnsRecord[],
  ownedSubdomains: readonly string[],
): RuleError | null {
  if (!(ALLOWED_TYPES as readonly string[]).includes(input.type)) {
    return {
      code: "RECORD_TYPE_NOT_ALLOWED",
      detail: `目前不開放 ${input.type} 紀錄`,
      errors: [{ path: "type", code: "RECORD_TYPE_NOT_ALLOWED", message: "目前不開放這個類型" }],
    };
  }
  if (input.type === "A" && ipv4Private(input.address)) {
    return {
      code: "IP_NOT_PUBLIC",
      detail: `${input.address} 是私有或保留位址，外部無法連線`,
      errors: [{ path: "address", code: "IP_NOT_PUBLIC", message: "必須是公網位址" }],
    };
  }
  if (input.type === "AAAA" && ipv6Private(input.address)) {
    return {
      code: "IP_NOT_PUBLIC",
      detail: `${input.address} 不是公網 IPv6 位址`,
      errors: [{ path: "address", code: "IP_NOT_PUBLIC", message: "必須在 2000::/3 之內" }],
    };
  }
  if (input.type === "CNAME" || input.type === "MX") {
    const target = input.type === "CNAME" ? input.target : input.exchange;
    const field = input.type === "CNAME" ? "target" : "exchange";
    const self =
      input.name === "@" ? `${sub}.${ROOT_DOMAIN}` : `${input.name}.${sub}.${ROOT_DOMAIN}`;
    if (target === self) {
      return {
        code: "RECORD_TARGET_NOT_ALLOWED",
        detail: "不能指向自己",
        errors: [{ path: field, code: "TARGET_SELF", message: "不能指向自己" }],
      };
    }
    if (target.endsWith(`.${ROOT_DOMAIN}`)) {
      const label =
        target
          .slice(0, -ROOT_DOMAIN.length - 1)
          .split(".")
          .pop() ?? "";
      if (!ownedSubdomains.includes(label)) {
        return {
          code: "RECORD_TARGET_NOT_ALLOWED",
          detail: `只能指向你自己擁有的 *.${ROOT_DOMAIN} 子網域`,
          errors: [{ path: field, code: "TARGET_NOT_OWNED", message: "只能指向你自己的子網域" }],
        };
      }
    }
  }
  const sameName = existing.filter((r) => r.name === input.name && r.syncStatus !== "deleting");
  if (input.type === "CNAME" && sameName.length > 0) {
    return {
      code: "RECORD_CONFLICT",
      detail: `${input.name} 已經有其他紀錄，CNAME 不能和其他紀錄同名`,
      errors: [{ path: "name", code: "CNAME_EXCLUSIVE", message: "這個名稱已有其他紀錄" }],
    };
  }
  if (input.type !== "CNAME" && sameName.some((r) => r.type === "CNAME")) {
    return {
      code: "RECORD_CONFLICT",
      detail: `${input.name} 已有 CNAME，不能再新增其他類型的紀錄`,
      errors: [{ path: "name", code: "CNAME_EXCLUSIVE", message: "同名已存在 CNAME" }],
    };
  }
  if (sameName.some((r) => r.type === input.type && dataOf(r) === dataOf(input))) {
    return {
      code: "RECORD_DUPLICATE",
      detail: "已經有一筆一模一樣的紀錄",
      errors: [{ path: "name", code: "RECORD_DUPLICATE", message: "重複的紀錄" }],
    };
  }
  return null;
}
