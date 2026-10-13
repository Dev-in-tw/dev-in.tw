import type { DnsRecord, RecordInput, RecordType } from "@dit/contract";
import { type RecordContext, toFqdn, type Verdict } from "../src/index.ts";

export const ROOT = "dev-in.tw";
export const SUB = "alice";
export const MVP_TYPES: readonly RecordType[] = ["A", "AAAA", "CNAME", "TXT", "MX"];
export const ALL_TYPES: readonly RecordType[] = ["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA"];

let seq = 0;
/** 把 RecordInput 包成 alice.dev-in.tw 底下的 DnsRecord */
export function rec(input: RecordInput): DnsRecord {
  seq += 1;
  return {
    ...input,
    id: `0199e2a2-1000-7000-8000-${seq.toString(16).padStart(12, "0")}`,
    fqdn: toFqdn(input.name, SUB, ROOT),
    version: 1,
    syncStatus: "synced",
    syncError: null,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
  };
}

export function ctx(overrides: Partial<RecordContext> = {}): RecordContext {
  return {
    sub: SUB,
    root: ROOT,
    existing: [],
    ownedSubdomains: [SUB],
    allowedTypes: ALL_TYPES,
    ...overrides,
  };
}

export function codesOf(v: Verdict): string[] {
  return v.ok ? [] : v.violations.map((x) => x.code);
}
