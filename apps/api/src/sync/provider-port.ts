import type { RecordType } from "@dit/contract";

/** DnsProvider port（PLAN §3.8、ADR-0005）。proxied 一律 false，所以不在介面上。 */
export interface ProviderRecordInput {
  fqdn: string;
  type: RecordType;
  ttl: number;
  content?: string;
  priority?: number;
  /** SRV、CAA 用 */
  data?: Record<string, string | number>;
  /** 所有權標記："dit:<recordId>" */
  comment: string;
}

export interface ProviderRecord extends Omit<ProviderRecordInput, "comment"> {
  id: string;
  comment: string | null;
  modifiedAt: string;
}

export interface BatchOps {
  deletes: string[];
  replaces: { id: string; input: ProviderRecordInput }[];
  creates: ProviderRecordInput[];
}

export interface ZoneInfo {
  name: string;
  plan: string | null;
  recordCount: number;
}

export interface DnsProvider {
  readonly kind: "cloudflare" | "memory";
  /** 自動分頁 */
  listAll(): AsyncIterable<ProviderRecord>;
  /** 依 comment 查找（用來接手「上次逾時但其實已建立」的紀錄） */
  findByComment(comment: string): Promise<ProviderRecord | null>;
  create(input: ProviderRecordInput): Promise<ProviderRecord>;
  /** PUT：只在 type 相同時使用（Cloudflare 已禁止就地改 type） */
  replace(id: string, input: ProviderRecordInput): Promise<ProviderRecord>;
  /** 404 視為成功 */
  delete(id: string): Promise<void>;
  /** 依 deletes → replaces → creates 的順序執行；provider 端 all-or-nothing */
  batch(ops: BatchOps): Promise<{ created: ProviderRecord[]; replaced: ProviderRecord[] }>;
  zoneInfo(): Promise<ZoneInfo>;
}

export const OWNERSHIP_PREFIX = "dit:";
export const ownershipComment = (recordId: string): string => `${OWNERSHIP_PREFIX}${recordId}`;
export function parseOwnership(comment: string | null | undefined): string | null {
  if (!comment?.startsWith(OWNERSHIP_PREFIX)) return null;
  const id = comment.slice(OWNERSHIP_PREFIX.length).trim();
  return /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null;
}
