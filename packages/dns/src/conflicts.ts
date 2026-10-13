import type { DnsRecord, RecordInput } from "@dit/contract";
import { describeRecord, isSameRecord } from "./record-data.ts";
import type { Violation } from "./types.ts";

/** 同一個名稱最多幾筆 TXT（§3.9） */
export const MAX_TXT_PER_NAME = 5;

/**
 * CNAME 排他、相同 (name, type, data) 重複、TXT 每個名稱最多 5 筆。
 * `existing` 是同一個子網域的其他紀錄（編輯時由呼叫端排除自己）。
 */
export function findConflicts(input: RecordInput, existing: readonly DnsRecord[]): Violation[] {
  const sameName = existing.filter((r) => r.name === input.name);
  const label = (r: DnsRecord) => r.fqdn;

  const duplicate = sameName.find((r) => isSameRecord(r, input));
  if (duplicate) {
    return [
      {
        path: "name",
        code: "RECORD_DUPLICATE",
        message: `已經有一筆相同的紀錄（${describeRecord(duplicate)}）`,
      },
    ];
  }

  const violations: Violation[] = [];
  const cname = sameName.find((r) => r.type === "CNAME");
  if (input.type === "CNAME") {
    if (cname) {
      violations.push({
        path: "name",
        code: "RECORD_CONFLICT",
        message: `${label(cname)} 已有 CNAME，同一個名稱只能有一筆 CNAME`,
      });
    } else {
      const other = sameName[0];
      if (other) {
        violations.push({
          path: "name",
          code: "RECORD_CONFLICT",
          message: `${label(other)} 已有 ${other.type} 紀錄，CNAME 不能和其他紀錄同名`,
        });
      }
    }
  } else if (cname) {
    violations.push({
      path: "name",
      code: "RECORD_CONFLICT",
      message: `${label(cname)} 已有 CNAME，不能再新增其他類型的紀錄`,
    });
  }

  if (input.type === "TXT") {
    const txtCount = sameName.filter((r) => r.type === "TXT").length;
    if (txtCount >= MAX_TXT_PER_NAME) {
      violations.push({
        path: "name",
        code: "RECORD_CONFLICT",
        message: `同一個名稱最多 ${MAX_TXT_PER_NAME} 筆 TXT 紀錄`,
      });
    }
  }
  return violations;
}
