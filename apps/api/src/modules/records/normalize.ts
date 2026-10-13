import type { RecordInput } from "@dit/contract";
import { canonicalIPv6 } from "@dit/dns";

const host = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");

/** 進入驗證前的正規化（PLAN §5.3：前端送出前會做，後端再做一次）：小寫、去掉結尾的點、IPv6 標準化 */
export function normalizeRecordInput(input: RecordInput): RecordInput {
  const name = input.name.trim().toLowerCase();
  switch (input.type) {
    case "A":
      return { ...input, name, address: input.address.trim() };
    case "AAAA":
      return { ...input, name, address: canonicalIPv6(input.address.trim()) };
    case "CNAME":
      return { ...input, name, target: host(input.target) };
    case "MX":
      return { ...input, name, exchange: host(input.exchange) };
    case "SRV":
      return { ...input, name, target: host(input.target) };
    case "TXT":
    case "CAA":
      return { ...input, name };
  }
}
