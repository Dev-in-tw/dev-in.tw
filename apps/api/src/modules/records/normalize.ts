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

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 驗證前的寬鬆正規化：只處理字串欄位，型別不對的值原樣交給 zod 回報 */
export function prenormalizeRecordBody(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  if (typeof out.name === "string")
    out.name = out.name.trim().toLowerCase().replace(/\.$/, "") || "@";
  for (const key of ["target", "exchange"]) {
    const value = out[key];
    if (typeof value === "string") out[key] = value.trim().toLowerCase().replace(/\.$/, "");
  }
  if (typeof out.address === "string") out.address = out.address.trim().toLowerCase();
  if (typeof out.type === "string") out.type = out.type.trim().toUpperCase();
  return out;
}

export function prenormalizePresetBody(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  return typeof raw.recordName === "string"
    ? { ...raw, recordName: raw.recordName.trim().toLowerCase() }
    : raw;
}
