import type { DnsRecord, RecordInput } from "@dit/contract";
import type { Violation } from "./types.ts";

/** CNAME 排他、相同 (name, type, data) 重複、TXT 每個名稱最多 5 筆 */
export function findConflicts(_input: RecordInput, _existing: readonly DnsRecord[]): Violation[] {
  // TODO(WP-A): 實作衝突檢查；stub 一律視為沒有衝突
  return [];
}
