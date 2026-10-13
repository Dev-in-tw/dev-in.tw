import type { DnsRecord } from "@dit/contract";

/** 例如 "www  300  IN  CNAME  alice.github.io." */
export function toZoneLine(r: DnsRecord): string {
  // TODO(WP-A): 依類型輸出資料欄位（MX、SRV、CAA、TXT 引號與拆段），並對齊欄寬
  return `${r.name}  ${r.ttl}  IN  ${r.type}`;
}
