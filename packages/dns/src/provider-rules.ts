import type { RecordInput } from "@dit/contract";
import type { Violation } from "./types.ts";

/** DNS provider 的種類（apps/api 的 `DNS_PROVIDER`）。 */
export type DnsProviderKind = "cloudflare" | "memory" | "lazco";

/** Lazco DNS 保留給網域驗證的 label，任何名稱都不能含有它（cloud-infra-dns `RESERVED_LABEL`） */
export const LAZCO_RESERVED_LABEL = "_lazco-verify";

/** 只有字母、數字與連字號（LDH）：Lazco DNS 的 MX / SRV 目標不接受底線 */
const LDH_HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** PowerDNS 5.1 的 API 存不了含引號、反斜線（或非 ASCII）的 character-string，Lazco DNS 會拒絕 */
const UNSTORABLE = /["\\]/;

/**
 * 某個 provider 額外的限制（Dev-in 本身的規則以外）。目前只有 Lazco DNS 有：
 *
 * - TXT 與 CAA 的內容不能有 `"` 或 `\`（Dev-in 已限制為可列印 ASCII，所以不會有大於 0x7e 的位元組）；
 * - MX 的郵件伺服器、SRV 的目標只能用 LDH（不能有底線）；
 * - 名稱不能含有 `_lazco-verify` label。
 *
 * Lazco DNS 的寫入是整批全有或全無，又有每日批次上限：一筆它不接受的紀錄會讓整批失敗、浪費額度。
 * API 在寫入時就擋下（VALIDATION_FAILED），sync worker 送出前也會再檢查一次。
 * 規則依 cloud-infra-dns `src/validation/rrset.ts`（2026-10-10 的 main）。
 */
export function providerViolations(input: RecordInput, provider: DnsProviderKind): Violation[] {
  if (provider !== "lazco") return [];
  const out: Violation[] = [];
  if (input.name.split(".").includes(LAZCO_RESERVED_LABEL)) {
    out.push({
      path: "name",
      code: "VALIDATION_FAILED",
      message: `${LAZCO_RESERVED_LABEL} 是 DNS 服務保留的名稱，不能使用`,
    });
  }
  switch (input.type) {
    case "TXT":
    case "CAA":
      if (UNSTORABLE.test(input.value)) {
        out.push({
          path: "value",
          code: "VALIDATION_FAILED",
          message: `${input.type} 內容不能包含雙引號（"）或反斜線（\\），目前的 DNS 服務無法儲存`,
        });
      }
      break;
    case "MX":
      if (!LDH_HOSTNAME.test(input.exchange)) {
        out.push({
          path: "exchange",
          code: "VALIDATION_FAILED",
          message: "郵件伺服器的名稱只能使用英數字與連字號，不能有底線",
        });
      }
      break;
    case "SRV":
      if (!LDH_HOSTNAME.test(input.target)) {
        out.push({
          path: "target",
          code: "VALIDATION_FAILED",
          message: "SRV 目標的名稱只能使用英數字與連字號，不能有底線",
        });
      }
      break;
    default:
      break;
  }
  return out;
}
