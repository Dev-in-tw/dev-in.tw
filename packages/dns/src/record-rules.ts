import type { DnsRecord, RecordInput, RecordType } from "@dit/contract";
import { OK, type Verdict } from "./types.ts";

export interface RecordContext {
  sub: string;
  root: string;
  /** 同一個子網域的其他紀錄（編輯時排除自己） */
  existing: readonly DnsRecord[];
  /** 用來允許 CNAME 指向自己的其他子網域 */
  ownedSubdomains: readonly string[];
  allowedTypes: readonly RecordType[];
}

/** 相對名稱轉 FQDN："@" → "<sub>.<root>"，"www" → "www.<sub>.<root>" */
export function toFqdn(recordName: string, sub: string, root: string): string {
  return recordName === "@" ? `${sub}.${root}` : `${recordName}.${sub}.${root}`;
}

/** 含 CNAME 排他、重複、TXT 每名稱上限、SRV 名稱格式（§3.9） */
export function validateRecord(_input: RecordInput, _ctx: RecordContext): Verdict {
  // TODO(WP-A): 實作各類型規則（公網 IP、CNAME 目標、FQDN 長度、類型白名單等），並呼叫 findConflicts；
  // stub 一律視為合法
  return OK;
}
