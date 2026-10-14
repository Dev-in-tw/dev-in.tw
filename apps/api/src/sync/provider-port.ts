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
  /** 容量單位的用量（Cloudflare：紀錄數；Lazco DNS：RRset 數，不含 apex 的 SOA／NS） */
  recordCount: number;
  /** provider 回報的容量上限（Lazco DNS 的 maxRrsets）；不知道時省略 */
  capacity?: number;
}

export type ProviderKind = "cloudflare" | "memory" | "lazco";

/** provider 上的一個 RRset（同名同類型，共用一個 TTL）。values 是 provider 的 presentation form。 */
export interface ProviderRrset {
  fqdn: string;
  type: string;
  ttl: number;
  values: string[];
}

export type RrsetChange =
  | { action: "REPLACE"; fqdn: string; type: string; ttl: number; values: string[] }
  /** expected：送出時 RRset 應該要有的值（provider 端不符就整批拒絕） */
  | { action: "DELETE"; fqdn: string; type: string; expected: string[] };

export interface RrsetZone {
  version: number;
  rrsets: ProviderRrset[];
}

/** 每日批次額度（Lazco DNS 每個 zone 每個 UTC 日最多 90 批）。實作在 sync/change-budget.ts。 */
export interface ChangeBudget {
  readonly dailyBudget: number;
  /** 取一個批次額度；今天已經用完時回傳 false */
  take(now: Date): Promise<boolean>;
  /** provider 回報當日上限已到（例如有人在 Lazco 面板改過紀錄）：把今天的用量設為已滿 */
  exhaust(now: Date): Promise<void>;
  state(now: Date): Promise<{ usedToday: number; lastBatchAt: Date | null }>;
}

/**
 * 以 RRset 讀改寫的 provider（Lazco DNS）。write() 每次都從最新的 zone 重新規劃：GET → plan →
 * PATCH（帶版本）；版本衝突、同 zone 有其他寫入、結果不明時重新 GET 再 plan，所以 plan 必須是
 * 「從期望狀態算出整個 RRset」的冪等函式，已經生效的變更再算一次會變成空的。
 */
export interface RrsetWriter {
  readonly maxChangesPerBatch: number;
  readonly budget: ChangeBudget;
  /** 合約的 TTL（1 = 自動）→ provider 接受的 TTL */
  normalizeTtl(ttl: number): number;
  /** ProviderRecordInput → provider 的 presentation form（RRset 裡的一個值） */
  valueOf(input: ProviderRecordInput): string;
  /** 穩定的紀錄 id：`<fqdn>|<type>|<canonical value>`（兩邊用同一套正規化） */
  idOf(fqdn: string, type: string, value: string): string;
  readZone(): Promise<RrsetZone>;
  /**
   * 反覆 plan → PATCH 直到 plan 回傳空陣列（一次最多 maxChangesPerBatch 個變更，每次 PATCH 扣一個額度）。
   * 回傳最後的 zone 狀態與送出的 PATCH 數。
   */
  write(plan: (zone: RrsetZone) => RrsetChange[]): Promise<{ zone: RrsetZone; patches: number }>;
}

export interface DnsProvider {
  readonly kind: ProviderKind;
  /**
   * provider 能不能在紀錄上存 comment（`dit:<recordId>` 所有權標記）。false（Lazco DNS）時，
   * 所有權改由 DB 判斷：dns_provider_ownership 表與 DB 紀錄的期望值（sync/ownership.ts）。
   */
  readonly supportsComments: boolean;
  /** 有值時 worker 改用 RRset 批次寫入（sync/batch.ts），不使用下面的單筆方法 */
  readonly rrsets?: RrsetWriter;
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
