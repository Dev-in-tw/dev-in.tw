import type { RecordInput } from "@dit/contract";
import { canonicalIPv6 } from "./ip-rules.ts";

/** TXT 單一 character-string 的上限（RFC 1035） */
export const TXT_CHUNK = 255;

const fqdnDot = (name: string) => `${name.toLowerCase().replace(/\.$/, "")}.`;
const quote = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** 把 TXT 內容切成 ≤ 255 字元的片段，每段各自加上引號（先切再跳脫） */
export function txtChunks(value: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += TXT_CHUNK) chunks.push(value.slice(i, i + TXT_CHUNK));
  return chunks.length === 0 ? [""] : chunks;
}

/** zone file 的資料欄（RDATA） */
export function zoneData(r: RecordInput): string {
  switch (r.type) {
    case "A":
      return r.address;
    case "AAAA":
      return canonicalIPv6(r.address);
    case "CNAME":
      return fqdnDot(r.target);
    case "TXT":
      return txtChunks(r.value).map(quote).join(" ");
    case "MX":
      return `${r.priority} ${fqdnDot(r.exchange)}`;
    case "SRV":
      return `${r.priority} ${r.weight} ${r.port} ${fqdnDot(r.target)}`;
    case "CAA":
      return `${r.flags} ${r.tag} ${quote(r.value)}`;
  }
}

/** 例如 "www  300  IN  CNAME  alice.github.io."（TTL 1 代表自動，原樣輸出） */
export function toZoneLine(r: RecordInput): string {
  return `${r.name}  ${r.ttl}  IN  ${r.type}  ${zoneData(r)}`;
}

/** 多筆紀錄輸出成欄位對齊的 zone file 片段（保留輸入順序，每行結尾不含空白） */
export function toZoneFile(records: readonly RecordInput[]): string {
  const width = (pick: (r: RecordInput) => string) =>
    Math.max(0, ...records.map((r) => pick(r).length));
  const nameWidth = width((r) => r.name);
  const ttlWidth = width((r) => String(r.ttl));
  const typeWidth = width((r) => r.type);
  return records
    .map((r) =>
      [
        r.name.padEnd(nameWidth),
        String(r.ttl).padEnd(ttlWidth),
        "IN",
        r.type.padEnd(typeWidth),
        zoneData(r),
      ].join("  "),
    )
    .join("\n");
}
