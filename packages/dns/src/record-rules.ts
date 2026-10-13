import {
  type DnsRecord,
  HOSTNAME_RE,
  RECORD_NAME_RE,
  type RecordInput,
  type RecordType,
} from "@dit/contract";
import { findConflicts } from "./conflicts.ts";
import { describeNonPublicIPv4, describeNonPublicIPv6, isIPAddress } from "./ip-rules.ts";
import type { Violation } from "./types.ts";
import { type Verdict, verdictOf } from "./types.ts";

export interface RecordContext {
  sub: string;
  root: string;
  /** 同一個子網域的其他紀錄（編輯時排除自己） */
  existing: readonly DnsRecord[];
  /** 用來允許 CNAME 指向自己的其他子網域 */
  ownedSubdomains: readonly string[];
  allowedTypes: readonly RecordType[];
}

export const MAX_FQDN_LENGTH = 253;
export const TXT_MAX_LENGTH = 2048;
export const SRV_PROTOCOLS = ["_tcp", "_udp", "_tls"] as const;
export const CAA_TAGS = ["issue", "issuewild", "iodef"] as const;

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const SRV_NAME_RE =
  /^_[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(_tcp|_udp|_tls)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)?$/;
const MAX_CNAME_CHAIN = 16;

/** 相對名稱轉 FQDN："@" → "<sub>.<root>"，"www" → "www.<sub>.<root>" */
export function toFqdn(recordName: string, sub: string, root: string): string {
  return recordName === "@" ? `${sub}.${root}` : `${recordName}.${sub}.${root}`;
}

/** TTL：1（自動）或 60–86,400 秒 */
export function isValidTtl(ttl: number): boolean {
  return ttl === 1 || (Number.isInteger(ttl) && ttl >= 60 && ttl <= 86_400);
}

const isUint16 = (n: number, min = 0) => Number.isInteger(n) && n >= min && n <= 65_535;

/**
 * 主機名稱落在 `<root>` 底下時，回傳它屬於哪一個子網域（root 左邊那個 label）；
 * 等於 root 本身時回 ""；不在 root 底下時回 null。
 */
export function subdomainOf(hostname: string, root: string): string | null {
  if (hostname === root) return "";
  if (!hostname.endsWith(`.${root}`)) return null;
  const labels = hostname.slice(0, -(root.length + 1)).split(".");
  return labels[labels.length - 1] ?? "";
}

function checkHostnameTarget(
  value: string,
  path: string,
  what: string,
  ctx: RecordContext,
  out: Violation[],
): boolean {
  if (isIPAddress(value)) {
    out.push({
      path,
      code: "RECORD_TARGET_NOT_ALLOWED",
      message: `${what}必須是主機名稱，不能是 IP 位址`,
    });
    return false;
  }
  if (!HOSTNAME_RE.test(value)) {
    out.push({
      path,
      code: "VALIDATION_FAILED",
      message: `${what}不是合法的主機名稱（例如 example.com，不含結尾的點）`,
    });
    return false;
  }
  const owner = subdomainOf(value, ctx.root);
  if (owner !== null && owner !== ctx.sub && !ctx.ownedSubdomains.includes(owner)) {
    out.push({
      path,
      code: "RECORD_TARGET_NOT_ALLOWED",
      message:
        owner === ""
          ? `${what}不能指向 ${ctx.root} 本身`
          : `${what}指向 ${ctx.root} 底下時，只能指向你自己擁有的子網域`,
    });
    return false;
  }
  return true;
}

/** CNAME 目標是否會繞回自己（只看同一個子網域內已知的 CNAME） */
function formsCnameLoop(fqdn: string, target: string, ctx: RecordContext): boolean {
  const aliases = new Map<string, string>();
  for (const r of ctx.existing) if (r.type === "CNAME") aliases.set(r.fqdn, r.target);
  let current: string | undefined = target;
  for (let i = 0; current !== undefined && i < MAX_CNAME_CHAIN; i++) {
    if (current === fqdn) return true;
    current = aliases.get(current);
  }
  return false;
}

function checkData(input: RecordInput, fqdn: string, ctx: RecordContext, out: Violation[]) {
  switch (input.type) {
    case "A":
    case "AAAA": {
      const reason =
        input.type === "A"
          ? describeNonPublicIPv4(input.address)
          : describeNonPublicIPv6(input.address);
      if (reason === null) return;
      const invalid = reason.startsWith("不是合法");
      out.push({
        path: "address",
        code: invalid ? "VALIDATION_FAILED" : "IP_NOT_PUBLIC",
        message: `${input.address} ${invalid ? reason : `是${reason}，外部無法連線`}`,
      });
      return;
    }
    case "CNAME": {
      if (input.target === fqdn) {
        out.push({
          path: "target",
          code: "RECORD_TARGET_NOT_ALLOWED",
          message: "CNAME 不能指向自己",
        });
        return;
      }
      if (!checkHostnameTarget(input.target, "target", "CNAME 目標", ctx, out)) return;
      if (formsCnameLoop(fqdn, input.target, ctx)) {
        out.push({
          path: "target",
          code: "RECORD_TARGET_NOT_ALLOWED",
          message: "CNAME 會形成循環，最後又指回自己",
        });
      }
      return;
    }
    case "TXT": {
      if (input.value.length < 1 || input.value.length > TXT_MAX_LENGTH) {
        out.push({
          path: "value",
          code: "VALIDATION_FAILED",
          message: `TXT 內容必須是 1–${TXT_MAX_LENGTH} 個字元`,
        });
      } else if (!PRINTABLE_ASCII.test(input.value)) {
        out.push({
          path: "value",
          code: "VALIDATION_FAILED",
          message: "TXT 內容只能使用可列印的 ASCII 字元（不能有中文、換行或控制字元）",
        });
      }
      return;
    }
    case "MX": {
      if (!isUint16(input.priority)) {
        out.push({
          path: "priority",
          code: "VALIDATION_FAILED",
          message: "優先順序必須是 0–65535",
        });
      }
      if (!checkHostnameTarget(input.exchange, "exchange", "郵件伺服器", ctx, out)) return;
      if (ctx.existing.some((r) => r.type === "CNAME" && r.fqdn === input.exchange)) {
        out.push({
          path: "exchange",
          code: "RECORD_TARGET_NOT_ALLOWED",
          message: "郵件伺服器不能指向 CNAME（RFC 2181），請改指向 A 或 AAAA 紀錄的名稱",
        });
      }
      return;
    }
    case "SRV": {
      if (!SRV_NAME_RE.test(input.name)) {
        out.push({
          path: "name",
          code: "VALIDATION_FAILED",
          message: `SRV 名稱必須是 _服務._協定 的格式，協定為 ${SRV_PROTOCOLS.join("、")}（例如 _minecraft._tcp）`,
        });
      }
      for (const key of ["priority", "weight"] as const) {
        if (!isUint16(input[key])) {
          out.push({ path: key, code: "VALIDATION_FAILED", message: `${key} 必須是 0–65535` });
        }
      }
      if (!isUint16(input.port, 1)) {
        out.push({ path: "port", code: "VALIDATION_FAILED", message: "連接埠必須是 1–65535" });
      }
      checkHostnameTarget(input.target, "target", "SRV 目標", ctx, out);
      return;
    }
    case "CAA": {
      if (input.flags !== 0 && input.flags !== 128) {
        out.push({
          path: "flags",
          code: "VALIDATION_FAILED",
          message: "CAA flags 只能是 0 或 128",
        });
      }
      if (!(CAA_TAGS as readonly string[]).includes(input.tag)) {
        out.push({
          path: "tag",
          code: "VALIDATION_FAILED",
          message: `CAA tag 只能是 ${CAA_TAGS.join("、")}`,
        });
      }
      if (
        input.value.length < 1 ||
        input.value.length > 255 ||
        !PRINTABLE_ASCII.test(input.value)
      ) {
        out.push({
          path: "value",
          code: "VALIDATION_FAILED",
          message: "CAA 內容必須是 1–255 個可列印的 ASCII 字元",
        });
      } else if (input.tag === "iodef" && !/^(?:mailto:|https?:\/\/)\S+$/.test(input.value)) {
        out.push({
          path: "value",
          code: "VALIDATION_FAILED",
          message: "iodef 必須是 mailto: 或 https:// 開頭的網址",
        });
      }
      return;
    }
  }
}

/**
 * 驗證單筆紀錄：類型白名單、名稱與 FQDN 長度、TTL、各類型的資料規則（§3.9），
 * 最後檢查和既有紀錄的衝突（CNAME 排他、重複、TXT 每名稱上限）。
 *
 * violation 的 code 盡量對應合約的 ErrorCode（IP_NOT_PUBLIC、RECORD_TYPE_NOT_ALLOWED、
 * RECORD_TARGET_NOT_ALLOWED、RECORD_CONFLICT、RECORD_DUPLICATE），其餘為 VALIDATION_FAILED。
 * 順序固定為：類型 → 名稱 → TTL → 資料 → 衝突，API 以第一個 violation 決定 Problem.code。
 */
export function validateRecord(input: RecordInput, ctx: RecordContext): Verdict {
  if (!ctx.allowedTypes.includes(input.type)) {
    return verdictOf([
      {
        path: "type",
        code: "RECORD_TYPE_NOT_ALLOWED",
        message: `目前不開放 ${input.type} 紀錄（可用：${ctx.allowedTypes.join("、")}）`,
      },
    ]);
  }

  const violations: Violation[] = [];
  const fqdn = toFqdn(input.name, ctx.sub, ctx.root);
  const nameOk = RECORD_NAME_RE.test(input.name);
  if (!nameOk) {
    violations.push({
      path: "name",
      code: "VALIDATION_FAILED",
      message: "名稱必須是 @ 或 1–3 段小寫英數 label（可以底線開頭，例如 _acme-challenge）",
    });
  } else if (fqdn.length > MAX_FQDN_LENGTH) {
    violations.push({
      path: "name",
      code: "VALIDATION_FAILED",
      message: `完整網域名稱不能超過 ${MAX_FQDN_LENGTH} 個字元`,
    });
  }
  if (!isValidTtl(input.ttl)) {
    violations.push({
      path: "ttl",
      code: "VALIDATION_FAILED",
      message: "TTL 必須是 1（自動）或 60–86400 秒",
    });
  }
  checkData(input, fqdn, ctx, violations);
  if (nameOk) violations.push(...findConflicts(input, ctx.existing));
  return verdictOf(violations);
}
