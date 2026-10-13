import { z } from "zod";
import { Hostname, IsoDateTime, RecordName, Usage, Uuid } from "./primitives.ts";

export const RecordType = z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA"]);
export type RecordType = z.infer<typeof RecordType>;
export const Ttl = z.union([z.literal(1), z.int().min(60).max(86_400)]);
export type Ttl = z.infer<typeof Ttl>;

const common = { name: RecordName, ttl: Ttl };
export const ARecordInput = z.object({ type: z.literal("A"), ...common, address: z.ipv4() });
export const AAAARecordInput = z.object({ type: z.literal("AAAA"), ...common, address: z.ipv6() });
export const CNAMERecordInput = z.object({ type: z.literal("CNAME"), ...common, target: Hostname });
export const TXTRecordInput = z.object({
  type: z.literal("TXT"),
  ...common,
  value: z.string().min(1).max(2048),
});
export const MXRecordInput = z.object({
  type: z.literal("MX"),
  ...common,
  priority: z.int().min(0).max(65_535),
  exchange: Hostname,
});
export const SRVRecordInput = z.object({
  type: z.literal("SRV"),
  ...common,
  priority: z.int().min(0).max(65_535),
  weight: z.int().min(0).max(65_535),
  port: z.int().min(1).max(65_535),
  target: Hostname,
});
export const CAARecordInput = z.object({
  type: z.literal("CAA"),
  ...common,
  flags: z.union([z.literal(0), z.literal(128)]),
  tag: z.enum(["issue", "issuewild", "iodef"]),
  value: z.string().min(1).max(255),
});
export const RecordInput = z.discriminatedUnion("type", [
  ARecordInput,
  AAAARecordInput,
  CNAMERecordInput,
  TXTRecordInput,
  MXRecordInput,
  SRVRecordInput,
  CAARecordInput,
]);
export type RecordInput = z.infer<typeof RecordInput>;

export const SyncStatus = z.enum(["pending", "synced", "error", "deleting"]);
export type SyncStatus = z.infer<typeof SyncStatus>;
export const RecordMeta = z.object({
  id: Uuid,
  fqdn: z.string(),
  version: z.int().positive(),
  syncStatus: SyncStatus,
  syncError: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RecordMeta = z.infer<typeof RecordMeta>;
export const DnsRecord = z.intersection(RecordInput, RecordMeta);
export type DnsRecord = z.infer<typeof DnsRecord>;

export const RecordList = z.object({ items: z.array(DnsRecord), usage: Usage });
export type RecordList = z.infer<typeof RecordList>;

export const ResolverId = z.enum(["cloudflare", "google", "quad9", "quad101"]);
export type ResolverId = z.infer<typeof ResolverId>;
export const Propagation = z.object({
  fqdn: z.string(),
  type: RecordType,
  expected: z.array(z.string()),
  resolvers: z.array(
    z.object({
      id: ResolverId,
      label: z.string(), // 例如 "Cloudflare 1.1.1.1"、"TWNIC Quad101"
      answers: z.array(z.string()),
      matches: z.boolean(),
      latencyMs: z.int().nullable(),
      error: z.string().nullable(),
    }),
  ),
  checkedAt: IsoDateTime,
});
export type Propagation = z.infer<typeof Propagation>;
export const PropagationQuery = z.object({ recordName: RecordName.default("@"), type: RecordType });
export type PropagationQuery = z.infer<typeof PropagationQuery>;
