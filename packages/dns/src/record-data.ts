import type { RecordInput } from "@dit/contract";
import { canonicalIPv6 } from "./ip-rules.ts";

const host = (name: string) => name.toLowerCase().replace(/\.$/, "");

/**
 * 紀錄資料部分的文字表示（不含名稱與 TTL），例如 MX 是 "10 mx.example.com"。
 * 主機名稱一律小寫、不含結尾的點；IPv6 轉成 RFC 5952 標準格式，所以也能拿來比對是否重複。
 */
export function recordContent(r: RecordInput): string {
  switch (r.type) {
    case "A":
      return r.address;
    case "AAAA":
      return canonicalIPv6(r.address);
    case "CNAME":
      return host(r.target);
    case "TXT":
      return r.value;
    case "MX":
      return `${r.priority} ${host(r.exchange)}`;
    case "SRV":
      return `${r.priority} ${r.weight} ${r.port} ${host(r.target)}`;
    case "CAA":
      return `${r.flags} ${r.tag} "${r.value}"`;
  }
}

/** 類型與資料相同（不比較名稱與 TTL） */
export function recordDataEquals(a: RecordInput, b: RecordInput): boolean {
  return a.type === b.type && recordContent(a) === recordContent(b);
}

/** 相同名稱、類型與資料：§3.9 的「重複」 */
export function isSameRecord(a: RecordInput, b: RecordInput): boolean {
  return a.name === b.name && recordDataEquals(a, b);
}

/** 給錯誤訊息用的簡短描述，例如 "@ A 1.2.3.4" */
export function describeRecord(r: RecordInput): string {
  return `${r.name} ${r.type} ${recordContent(r)}`;
}
