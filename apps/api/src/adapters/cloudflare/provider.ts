import type { RecordType } from "@dit/contract";
import type {
  BatchOps,
  DnsProvider,
  ProviderRecord,
  ProviderRecordInput,
  ZoneInfo,
} from "../../sync/provider-port.ts";
import type { FetchLike } from "../http.ts";
import { CloudflareClient, isNotFound } from "./client.ts";

/** Cloudflare API 的 DNS record 形狀（只列用到的欄位） */
export interface CfDnsRecord {
  id: string;
  name: string;
  type: string;
  ttl: number;
  content?: string;
  priority?: number;
  data?: Record<string, string | number>;
  comment?: string | null;
  modified_on?: string;
  proxied?: boolean;
}

export interface CloudflareProviderOptions {
  apiToken: string;
  zoneId: string;
  apiBase?: string;
  fetch?: FetchLike;
  requestsPerSecond?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const PAGE_SIZE = 500;

/**
 * Cloudflare 版 DnsProvider（ADR-0005）。proxied 一律 false（ADR-0007）。
 *
 * listAll() 會連同非受管的類型（NS、SOA 以外的 HTTPS、SVCB 等）一起回傳，
 * 型別直接轉成 RecordType（實際字串可能不在 RecordType 裡）：reconciler 只對有 `dit:` 標記的紀錄動作，
 * 其他紀錄只用來計算 zone 用量與 unmanaged 報告。
 */
export class CloudflareProvider implements DnsProvider {
  readonly kind = "cloudflare" as const;
  readonly supportsComments = true;
  readonly #client: CloudflareClient;
  readonly #zone: string;

  constructor(opts: CloudflareProviderOptions) {
    this.#zone = encodeURIComponent(opts.zoneId);
    this.#client = new CloudflareClient({
      apiToken: opts.apiToken,
      apiBase: opts.apiBase ?? "https://api.cloudflare.com/client/v4",
      requestsPerSecond: opts.requestsPerSecond ?? 3,
      timeoutMs: opts.timeoutMs ?? 10_000,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
  }

  get #records(): string {
    return `/zones/${this.#zone}/dns_records`;
  }

  async *listAll(): AsyncIterable<ProviderRecord> {
    let page = 1;
    let totalPages = 1;
    do {
      const env = await this.#client.request<CfDnsRecord[]>(
        "GET",
        `${this.#records}?per_page=${PAGE_SIZE}&page=${page}`,
      );
      for (const r of env.result ?? []) yield fromCloudflare(r);
      totalPages = env.result_info?.total_pages ?? 1;
      page++;
    } while (page <= totalPages);
  }

  async findByComment(comment: string): Promise<ProviderRecord | null> {
    const q = new URLSearchParams({ "comment.exact": comment, per_page: "5" });
    const env = await this.#client.request<CfDnsRecord[]>("GET", `${this.#records}?${q}`);
    const first = env.result?.find((r) => r.comment === comment) ?? env.result?.[0];
    return first ? fromCloudflare(first) : null;
  }

  async create(input: ProviderRecordInput): Promise<ProviderRecord> {
    const env = await this.#client.request<CfDnsRecord>("POST", this.#records, toCloudflare(input));
    return fromCloudflare(env.result);
  }

  async replace(id: string, input: ProviderRecordInput): Promise<ProviderRecord> {
    const env = await this.#client.request<CfDnsRecord>(
      "PUT",
      `${this.#records}/${encodeURIComponent(id)}`,
      toCloudflare(input),
    );
    return fromCloudflare(env.result);
  }

  async delete(id: string): Promise<void> {
    try {
      await this.#client.request("DELETE", `${this.#records}/${encodeURIComponent(id)}`);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async batch(ops: BatchOps): Promise<{ created: ProviderRecord[]; replaced: ProviderRecord[] }> {
    const body: Record<string, unknown> = {};
    if (ops.deletes.length > 0) body.deletes = ops.deletes.map((id) => ({ id }));
    if (ops.replaces.length > 0) {
      body.puts = ops.replaces.map(({ id, input }) => ({ id, ...toCloudflare(input) }));
    }
    if (ops.creates.length > 0) body.posts = ops.creates.map(toCloudflare);
    if (Object.keys(body).length === 0) return { created: [], replaced: [] };
    const env = await this.#client.request<{
      deletes?: CfDnsRecord[];
      puts?: CfDnsRecord[];
      posts?: CfDnsRecord[];
    }>("POST", `${this.#records}/batch`, body);
    return {
      created: (env.result?.posts ?? []).map(fromCloudflare),
      replaced: (env.result?.puts ?? []).map(fromCloudflare),
    };
  }

  async zoneInfo(): Promise<ZoneInfo> {
    const zone = await this.#client.request<{
      name: string;
      plan?: { legacy_id?: string; name?: string } | null;
    }>("GET", `/zones/${this.#zone}`);
    const count = await this.#client.request<CfDnsRecord[]>("GET", `${this.#records}?per_page=1`);
    return {
      name: zone.result.name.toLowerCase(),
      plan: zone.result.plan?.legacy_id ?? zone.result.plan?.name ?? null,
      recordCount: count.result_info?.total_count ?? count.result?.length ?? 0,
    };
  }
}

/** ProviderRecordInput → Cloudflare request body */
export function toCloudflare(input: ProviderRecordInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: input.fqdn,
    type: input.type,
    ttl: input.ttl,
    proxied: false,
    comment: input.comment,
  };
  // SRV、CAA 只送 data（Cloudflare 由 data 產生 content）；其他類型只送 content
  const structured = input.type === "SRV" || input.type === "CAA";
  if (!structured && input.content !== undefined) body.content = input.content;
  if (input.type === "MX" && input.priority !== undefined) body.priority = input.priority;
  if (structured && input.data !== undefined) body.data = { ...input.data };
  return body;
}

/** Cloudflare record → ProviderRecord */
export function fromCloudflare(r: CfDnsRecord): ProviderRecord {
  const record: ProviderRecord = {
    id: r.id,
    fqdn: r.name.toLowerCase().replace(/\.$/, ""),
    type: r.type as RecordType,
    ttl: r.ttl,
    comment: r.comment ?? null,
    modifiedAt: r.modified_on ?? new Date(0).toISOString(),
  };
  if (r.type === "SRV" || r.type === "CAA") {
    if (r.data) record.data = { ...r.data };
  } else if (r.content !== undefined) {
    record.content = r.content;
  }
  if (r.type === "MX" && r.priority !== undefined) record.priority = r.priority;
  return record;
}
