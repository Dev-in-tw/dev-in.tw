import type { RecordType } from "@dit/contract";
import { decodeTxt, normalizeIPv6 } from "../../sync/mapper.ts";
import type {
  ProviderRecord,
  ProviderRecordInput,
  ProviderRrset,
} from "../../sync/provider-port.ts";

/**
 * Dev-in 的紀錄 ↔ Lazco DNS 的 RRset 值（presentation form，與 cloud-infra-dns `validateChanges`
 * 正規化後存進 PowerDNS 的形式相同）。
 *
 * 穩定 id 是 `<fqdn>|<TYPE>|<canonical value>`：兩邊（DB 的期望值、provider 讀回來的值）都經過
 * canonicalValue()，所以同一個值不論 provider 怎麼印（IPv6 壓縮、結尾的點、TXT 怎麼分段）都得到同一個 id。
 * canonicalValue 若和 Lazco DNS 的正規化不一致，對帳會一直判定 modified，所以每種類型都有測試。
 */

/** 合約的 TTL 1（自動）在 Lazco DNS 寫成 300 秒；比較 TTL 時兩邊都先經過這裡 */
export const LAZCO_AUTO_TTL = 300;
export const LAZCO_MIN_TTL = 60;
export const LAZCO_MAX_TTL = 86_400;

export function normalizeTtl(ttl: number): number {
  if (ttl === 1) return LAZCO_AUTO_TTL;
  return Math.min(LAZCO_MAX_TTL, Math.max(LAZCO_MIN_TTL, Math.round(ttl)));
}

const bare = (host: string): string => host.trim().toLowerCase().replace(/\.$/, "");
const absolute = (host: string): string => `${bare(host)}.`;

/** 以 `\x20` 以外的空白分段（presentation form 的欄位之間只有空白） */
const fields = (value: string): string[] => value.trim().split(/\s+/);

/** ProviderRecordInput → Lazco DNS 的 RRset 值 */
export function toLazcoValue(input: ProviderRecordInput): string {
  switch (input.type) {
    case "A":
    case "AAAA":
      return String(input.content ?? "").trim();
    case "CNAME":
      return absolute(String(input.content ?? ""));
    case "TXT":
      // encodeTxt 已經切成 255 字元一段並加上引號（mapper.ts）
      return String(input.content ?? "");
    case "MX":
      return `${Number(input.priority ?? 0)} ${absolute(String(input.content ?? ""))}`;
    case "SRV": {
      const d = input.data ?? {};
      return `${Number(d.priority)} ${Number(d.weight)} ${Number(d.port)} ${absolute(String(d.target))}`;
    }
    case "CAA": {
      const d = input.data ?? {};
      return `${Number(d.flags)} ${String(d.tag).toLowerCase()} "${String(d.value)}"`;
    }
  }
}

/** 比較與 id 用的正規化（不是送給 provider 的形式） */
export function canonicalValue(type: string, value: string): string {
  switch (type.toUpperCase()) {
    case "A":
      return value.trim();
    case "AAAA":
      return normalizeIPv6(value.trim());
    case "CNAME":
    case "NS":
    case "PTR":
    case "DNAME":
      return bare(value);
    case "MX": {
      const [preference = "", host = ""] = fields(value);
      return `${Number(preference)} ${bare(host)}`;
    }
    case "SRV": {
      const [priority = "", weight = "", port = "", target = ""] = fields(value);
      return `${Number(priority)} ${Number(weight)} ${Number(port)} ${bare(target)}`;
    }
    case "TXT":
      return decodeTxt(value);
    case "CAA": {
      const match = /^(\d{1,3})\s+([A-Za-z0-9]+)\s+(.*)$/s.exec(value.trim());
      if (!match) return value.trim();
      return `${Number(match[1])} ${(match[2] ?? "").toLowerCase()} ${decodeTxt(match[3] ?? "")}`;
    }
    default:
      return fields(value).join(" ");
  }
}

export const rrsetKey = (fqdn: string, type: string): string =>
  `${bare(fqdn)}|${type.toUpperCase()}`;

export function idOf(fqdn: string, type: string, value: string): string {
  return `${rrsetKey(fqdn, type)}|${canonicalValue(type, value)}`;
}

/** idOf 的反向：fqdn 與 type 不含 `|`，值可能含有，所以只切前兩個 */
export function parseId(id: string): { fqdn: string; type: string; canonical: string } | null {
  const first = id.indexOf("|");
  const second = first >= 0 ? id.indexOf("|", first + 1) : -1;
  if (first <= 0 || second <= first + 1) return null;
  return {
    fqdn: id.slice(0, first),
    type: id.slice(first + 1, second),
    canonical: id.slice(second + 1),
  };
}

/** RRset 裡的一個值 → ProviderRecord（形狀與 Cloudflare 相同，讓 mapper.sameRecord 共用） */
export function fromLazco(rrset: ProviderRrset, value: string): ProviderRecord {
  const fqdn = bare(rrset.fqdn);
  const type = rrset.type.toUpperCase();
  const record: ProviderRecord = {
    id: idOf(fqdn, type, value),
    fqdn,
    type: type as RecordType,
    ttl: rrset.ttl,
    comment: null,
    modifiedAt: new Date(0).toISOString(),
  };
  switch (type) {
    case "CNAME":
      record.content = bare(value);
      break;
    case "MX": {
      const [preference = "", host = ""] = fields(value);
      record.priority = Number(preference);
      record.content = bare(host);
      break;
    }
    case "SRV": {
      const [priority = "", weight = "", port = "", target = ""] = fields(value);
      record.data = {
        priority: Number(priority),
        weight: Number(weight),
        port: Number(port),
        target: bare(target),
      };
      break;
    }
    case "CAA": {
      const match = /^(\d{1,3})\s+([A-Za-z0-9]+)\s+(.*)$/s.exec(value.trim());
      record.data = match
        ? {
            flags: Number(match[1]),
            tag: (match[2] ?? "").toLowerCase(),
            value: decodeTxt(match[3] ?? ""),
          }
        : { flags: 0, tag: "", value: value.trim() };
      break;
    }
    default:
      record.content = value;
  }
  return record;
}
