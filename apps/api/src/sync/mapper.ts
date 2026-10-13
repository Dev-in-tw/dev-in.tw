import type { RecordType } from "@dit/contract";
import type { RecordRow } from "../db/schema.ts";
import {
  ownershipComment,
  type ProviderRecord,
  type ProviderRecordInput,
} from "./provider-port.ts";

/** 相對名稱 → FQDN */
export function fqdnOf(name: string, subdomain: string, root: string): string {
  return name === "@" ? `${subdomain}.${root}` : `${name}.${subdomain}.${root}`;
}

/** TXT 以 255 字元切段並加上引號（RFC 1035 character-string），引號與反斜線要跳脫 */
export function encodeTxt(value: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += 255) chunks.push(value.slice(i, i + 255));
  return chunks.map((c) => `"${c.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(" ");
}

/** encodeTxt 的反向；provider 端如果存的是沒有引號的字串就原樣回傳 */
export function decodeTxt(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('"')) return content;
  let out = "";
  let inQuote = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && inQuote && i + 1 < trimmed.length) {
      out += trimmed[++i];
    } else if (ch === '"') {
      inQuote = !inQuote;
    } else if (inQuote) {
      out += ch;
    }
  }
  return out;
}

type Data = Record<string, string | number>;

export function toProviderInput(
  record: Pick<RecordRow, "id" | "name" | "type" | "ttl" | "data">,
  subdomain: string,
  root: string,
): ProviderRecordInput {
  const fqdn = fqdnOf(record.name, subdomain, root);
  const d = record.data as Data;
  const base = { fqdn, type: record.type, ttl: record.ttl, comment: ownershipComment(record.id) };
  switch (record.type) {
    case "A":
    case "AAAA":
      return { ...base, content: String(d.address) };
    case "CNAME":
      return { ...base, content: String(d.target) };
    case "TXT":
      return { ...base, content: encodeTxt(String(d.value)) };
    case "MX":
      return { ...base, content: String(d.exchange), priority: Number(d.priority) };
    case "SRV":
      return {
        ...base,
        data: {
          priority: Number(d.priority),
          weight: Number(d.weight),
          port: Number(d.port),
          target: String(d.target),
        },
      };
    case "CAA":
      return {
        ...base,
        data: { flags: Number(d.flags), tag: String(d.tag), value: String(d.value) },
      };
  }
}

const lowerHost = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\.$/, "");

/** 比較 DB 的期望狀態與 provider 的實際狀態（給 reconciler 判斷 modified） */
export function sameRecord(desired: ProviderRecordInput, actual: ProviderRecord): boolean {
  if (lowerHost(desired.fqdn) !== lowerHost(actual.fqdn)) return false;
  if (desired.type !== actual.type || desired.ttl !== actual.ttl) return false;
  const type: RecordType = desired.type;
  switch (type) {
    case "A":
      return desired.content === actual.content;
    case "AAAA":
      return normalizeIPv6(desired.content) === normalizeIPv6(actual.content);
    case "CNAME":
      return lowerHost(desired.content) === lowerHost(actual.content);
    case "TXT":
      return decodeTxt(desired.content ?? "") === decodeTxt(actual.content ?? "");
    case "MX":
      return (
        lowerHost(desired.content) === lowerHost(actual.content) &&
        desired.priority === actual.priority
      );
    case "SRV":
    case "CAA": {
      const a = desired.data ?? {};
      const b = actual.data ?? {};
      return Object.keys(a).every((k) =>
        typeof a[k] === "string"
          ? lowerHost(String(a[k])) === lowerHost(String(b[k] ?? ""))
          : a[k] === Number(b[k]),
      );
    }
  }
}

/** 展開 IPv6 為 8 組 4 位數，方便比較（不合法時原樣回傳） */
export function normalizeIPv6(ip: string | undefined): string {
  if (!ip) return "";
  const lower = ip.toLowerCase();
  const [head, tail] = lower.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - h.length - t.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return lower;
  const groups = [...h, ...Array<string>(missing).fill("0"), ...t];
  return groups.map((g) => g.padStart(4, "0")).join(":");
}
