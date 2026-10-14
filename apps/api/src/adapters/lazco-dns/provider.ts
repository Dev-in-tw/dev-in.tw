import { MIDNIGHT_MARGIN_MS, nextUtcMidnight } from "../../sync/change-budget.ts";
import { asProviderError, ProviderError } from "../../sync/errors.ts";
import type {
  BatchOps,
  ChangeBudget,
  DnsProvider,
  ProviderRecord,
  ProviderRecordInput,
  ProviderRrset,
  RrsetChange,
  RrsetWriter,
  RrsetZone,
  ZoneInfo,
} from "../../sync/provider-port.ts";
import type { FetchLike } from "../http.ts";
import {
  classifyLazcoError,
  classifyLazcoException,
  type LazcoErrorBody,
  REPLAN_CODES,
} from "./errors.ts";
import {
  canonicalValue,
  fromLazco,
  idOf,
  normalizeTtl,
  parseId,
  rrsetKey,
  toLazcoValue,
} from "./values.ts";

/** cloud-infra-dns `MAX_CHANGES_PER_BATCH` 與 `MAX_RECORDS_PER_RRSET` */
export const LAZCO_MAX_CHANGES_PER_BATCH = 100;
export const LAZCO_MAX_RECORDS_PER_RRSET = 100;

export interface LazcoDnsProviderOptions {
  /** 限定 zone 的 Lazco API token（`lz_live_…`） */
  token: string;
  zoneId: string;
  /** 例如 https://api.lazco.tw（不含 /v1） */
  apiUrl: string;
  budget: ChangeBudget;
  /** 永遠不可寫入的 FQDN（SYSTEM_RECORD_NAMES）：adapter 層的最後防線，planner 已經先排除 */
  protectedFqdns?: readonly string[];
  fetch?: FetchLike;
  timeoutMs?: number;
  /** 一次 write() 內，重新讀取 zone 再試的次數上限（412、409、結果不明、逾時） */
  maxReplans?: number;
  /** 一次 write() 最多送出幾個 PATCH（防止 plan 不收斂時燒光額度） */
  maxPatchesPerWrite?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Lazco DNS 的 RRset（GET /v1/dns/zones/{id}/rrsets 的一項） */
interface LazcoRrset {
  name: string;
  type: string;
  ttl: number;
  records: { value: string }[];
  managed?: boolean;
  disabled?: boolean;
}

interface Answer<T> {
  status: number;
  body: T;
  etag: string | null;
}

/** ETag `"7"` → 7 */
function versionFromEtag(etag: string | null): number | null {
  const match = etag ? /^(?:W\/)?"(\d{1,15})"$/.exec(etag.trim()) : null;
  return match?.[1] ? Number(match[1]) : null;
}

const bare = (host: string) => host.trim().toLowerCase().replace(/\.$/, "");

/** 把變更依名稱分組後切成一批最多 max 個：同名的變更（例如刪 A、加 CNAME）一定在同一批 */
export function firstChunk(changes: readonly RrsetChange[], max: number): RrsetChange[] {
  const groups = new Map<string, RrsetChange[]>();
  for (const change of changes) {
    const name = bare(change.fqdn);
    const group = groups.get(name) ?? [];
    group.push(change);
    groups.set(name, group);
  }
  const chunk: RrsetChange[] = [];
  for (const group of groups.values()) {
    if (chunk.length > 0 && chunk.length + group.length > max) break;
    chunk.push(...group.slice(0, max));
    if (chunk.length >= max) break;
  }
  return chunk;
}

/** 把已送出的變更套用到本機的 zone 狀態（不用每批都重新 GET） */
export function applyLocal(zone: RrsetZone, changes: readonly RrsetChange[], version: number) {
  const state = new Map(zone.rrsets.map((r) => [rrsetKey(r.fqdn, r.type), r]));
  for (const change of changes) {
    const key = rrsetKey(change.fqdn, change.type);
    if (change.action === "DELETE") state.delete(key);
    else {
      state.set(key, {
        fqdn: bare(change.fqdn),
        type: change.type.toUpperCase(),
        ttl: change.ttl,
        values: [...change.values],
      });
    }
  }
  return { version, rrsets: [...state.values()] };
}

/**
 * Lazco DNS 版 DnsProvider（`DNS_PROVIDER=lazco`，PLAN §3.8.1）。呼叫 Lazco Cloud 公開 API
 * `<apiUrl>/v1/dns/zones/{zoneId}/rrsets`：
 *
 * - 單位是 RRset（同名同類型共用一個 TTL），沒有紀錄 id 也沒有 comment。紀錄 id 以
 *   `<fqdn>|<type>|<canonical value>` 合成（values.ts），所有權由 DB 判斷（sync/ownership.ts）。
 * - 寫入只有 `PATCH .../rrsets`：REPLACE／DELETE 的批次，全有或全無，最多 100 個變更，必須帶
 *   `If-Match: "<version>"`。每個 zone 每個 UTC 日最多 90 批，所以 worker 改用 rrsets.write() 聚合批次
 *   （sync/batch.ts）；下面的單筆方法（create／replace／delete／batch）只給 reconciler 刪孤兒之類的少量操作。
 * - 每次 PATCH 前從 ChangeBudget 取一個額度；額度用完時丟出 capacity + retryAt（下一個 UTC 日）。
 */
export class LazcoDnsProvider implements DnsProvider, RrsetWriter {
  readonly kind = "lazco" as const;
  readonly supportsComments = false;
  readonly maxChangesPerBatch = LAZCO_MAX_CHANGES_PER_BATCH;
  readonly budget: ChangeBudget;
  readonly #opts: LazcoDnsProviderOptions;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #protected: Set<string>;

  constructor(opts: LazcoDnsProviderOptions) {
    this.#opts = opts;
    this.budget = opts.budget;
    this.#fetch = opts.fetch ?? fetch;
    this.#now = opts.now ?? (() => new Date());
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#protected = new Set((opts.protectedFqdns ?? []).map(bare));
  }

  get rrsets(): RrsetWriter {
    return this;
  }

  get #zonePath(): string {
    return `/v1/dns/zones/${encodeURIComponent(this.#opts.zoneId)}`;
  }

  normalizeTtl(ttl: number): number {
    return normalizeTtl(ttl);
  }

  valueOf(input: ProviderRecordInput): string {
    return toLazcoValue(input);
  }

  idOf(fqdn: string, type: string, value: string): string {
    return idOf(fqdn, type, value);
  }

  async #request<T>(
    method: "GET" | "PATCH",
    path: string,
    opts: { body?: unknown; ifMatch?: string; keyOfIndex?: (index: number) => string | null } = {},
  ): Promise<Answer<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#opts.token}`,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.ifMatch !== undefined) headers["If-Match"] = opts.ifMatch;
    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(`${this.#opts.apiUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 10_000),
      });
      text = await res.text();
    } catch (error) {
      throw classifyLazcoException(error);
    }
    let body: unknown = null;
    try {
      body = text.trim() === "" ? null : JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      throw classifyLazcoError(
        res.status,
        typeof body === "object" && body !== null ? (body as LazcoErrorBody) : null,
        res.headers.get("retry-after"),
        this.#now(),
        opts.keyOfIndex,
      );
    }
    if (typeof body !== "object" || body === null) {
      throw new ProviderError(
        "transient",
        `http:${res.status}`,
        "DNS 服務的回應格式不正確，系統會自動重試",
        res.status,
      );
    }
    return { status: res.status, body: body as T, etag: res.headers.get("etag") };
  }

  async readZone(): Promise<RrsetZone> {
    const res = await this.#request<{ version?: number; rrsets?: LazcoRrset[] }>(
      "GET",
      `${this.#zonePath}/rrsets`,
    );
    const version =
      typeof res.body.version === "number" ? res.body.version : versionFromEtag(res.etag);
    if (version === null) {
      throw new ProviderError("transient", "lazco:no_version", "DNS 服務沒有回報 zone 版本");
    }
    const rrsets: ProviderRrset[] = (res.body.rrsets ?? [])
      // apex 的 NS 由 DNS 服務管理（managed），不能寫，也不算進 RRset 上限
      .filter((r) => r.managed !== true)
      .map((r) => ({
        fqdn: bare(r.name),
        type: r.type.toUpperCase(),
        ttl: r.ttl,
        values: (r.records ?? []).map((v) => v.value),
      }));
    return { version, rrsets };
  }

  async #patch(changes: readonly RrsetChange[], version: number): Promise<number> {
    const keys = changes.map((c) => rrsetKey(c.fqdn, c.type));
    const res = await this.#request<{ version?: number; status?: string }>(
      "PATCH",
      `${this.#zonePath}/rrsets`,
      {
        body: {
          rrsets: changes.map((c) =>
            c.action === "REPLACE"
              ? {
                  action: "REPLACE",
                  name: `${bare(c.fqdn)}.`,
                  type: c.type,
                  ttl: c.ttl,
                  records: c.values.map((value) => ({ value })),
                }
              : {
                  action: "DELETE",
                  name: `${bare(c.fqdn)}.`,
                  type: c.type,
                  ...(c.expected.length > 0
                    ? { expectedRecords: c.expected.map((value) => ({ value })) }
                    : {}),
                },
          ),
        },
        ifMatch: `"${version}"`,
        keyOfIndex: (index) => keys[index] ?? null,
      },
    );
    // 202 status=pending：DNS 服務已記下變更但 PowerDNS 的結果不明，由它的 reconciler 收尾；
    // 這裡視為已送出，Dev-in 的對帳會再確認一次
    return typeof res.body.version === "number"
      ? res.body.version
      : (versionFromEtag(res.etag) ?? version + 1);
  }

  #assertSafe(changes: readonly RrsetChange[]): void {
    for (const change of changes) {
      const fqdn = bare(change.fqdn);
      if (this.#protected.has(fqdn)) {
        throw new ProviderError(
          "permanent",
          "lazco:protected_name",
          `${fqdn} 是系統紀錄，不可由同步程式修改`,
        );
      }
      if (change.action === "REPLACE") {
        if (change.values.length === 0 || change.values.length > LAZCO_MAX_RECORDS_PER_RRSET) {
          throw new ProviderError("permanent", "lazco:rrset_size", "RRset 的值數量不合法");
        }
      }
    }
  }

  async write(
    plan: (zone: RrsetZone) => RrsetChange[],
  ): Promise<{ zone: RrsetZone; patches: number }> {
    const maxReplans = this.#opts.maxReplans ?? 3;
    const maxPatches = this.#opts.maxPatchesPerWrite ?? 10;
    let zone = await this.readZone();
    let patches = 0;
    let replans = 0;
    for (;;) {
      const changes = plan(zone);
      if (changes.length === 0) return { zone, patches };
      if (patches >= maxPatches) {
        throw new ProviderError(
          "transient",
          "lazco:not_converging",
          "DNS 變更沒有收斂，系統會稍後重試",
        );
      }
      const chunk = firstChunk(changes, this.maxChangesPerBatch);
      this.#assertSafe(chunk);
      const now = this.#now();
      if (!(await this.budget.take(now))) {
        throw new ProviderError(
          "capacity",
          "budget:exhausted",
          "今天的 DNS 變更批次額度已用完，會在下一個 UTC 日自動繼續",
          null,
          { retryAt: new Date(nextUtcMidnight(now).getTime() + MIDNIGHT_MARGIN_MS) },
        );
      }
      try {
        const version = await this.#patch(chunk, zone.version);
        patches++;
        zone = applyLocal(zone, chunk, version);
      } catch (error) {
        const pe = asProviderError(error);
        if (!REPLAN_CODES.has(pe.providerCode) || replans >= maxReplans) throw pe;
        replans++;
        // 409 DNS_CHANGE_IN_PROGRESS 的 Retry-After 固定是 2 秒
        if (pe.providerCode === "lazco:DNS_CHANGE_IN_PROGRESS") await this.#sleep(2000);
        // 重新讀取：412 是有人先改了、409 是另一個變更正在套用、逾時與 504 是結果不明（可能已生效）。
        // plan 是從期望狀態算出整個 RRset，已經生效的部分再算一次會變成空的。
        zone = await this.readZone();
      }
    }
  }

  // ── 單筆方法（DnsProvider）：每次呼叫就是一次 PATCH，只給少量操作使用 ──────────────────────

  async *listAll(): AsyncIterable<ProviderRecord> {
    const zone = await this.readZone();
    for (const rrset of zone.rrsets) {
      for (const value of rrset.values) yield fromLazco(rrset, value);
    }
  }

  /** Lazco DNS 沒有 comment；所有權改由 DB 判斷 */
  async findByComment(_comment: string): Promise<ProviderRecord | null> {
    return null;
  }

  async create(input: ProviderRecordInput): Promise<ProviderRecord> {
    const out = await this.batch({ deletes: [], replaces: [], creates: [input] });
    return out.created[0] as ProviderRecord;
  }

  async replace(id: string, input: ProviderRecordInput): Promise<ProviderRecord> {
    const out = await this.batch({ deletes: [], replaces: [{ id, input }], creates: [] });
    return out.replaced[0] as ProviderRecord;
  }

  async delete(id: string): Promise<void> {
    await this.batch({ deletes: [id], replaces: [], creates: [] });
  }

  /**
   * 依 id 刪值、換值、加值。每個受影響的 RRset 以 REPLACE（或最後一個值被刪掉時以 DELETE）寫入，
   * 其他值原樣保留；新值的 TTL 取該 RRset 現有 TTL 與新 TTL 的最小值。
   */
  async batch(ops: BatchOps): Promise<{ created: ProviderRecord[]; replaced: ProviderRecord[] }> {
    const removals = new Set([...ops.deletes, ...ops.replaces.map((r) => r.id)]);
    const additions = [...ops.replaces.map((r) => r.input), ...ops.creates];
    if (removals.size === 0 && additions.length === 0) return { created: [], replaced: [] };
    const plan = (zone: RrsetZone): RrsetChange[] => {
      const state = new Map(
        zone.rrsets.map((r) => [rrsetKey(r.fqdn, r.type), { ...r, values: [...r.values] }]),
      );
      const touched = new Set<string>();
      for (const id of removals) {
        const parsed = parseId(id);
        if (!parsed) continue;
        const key = rrsetKey(parsed.fqdn, parsed.type);
        const rrset = state.get(key);
        if (!rrset) continue;
        const kept = rrset.values.filter((v) => canonicalValue(rrset.type, v) !== parsed.canonical);
        if (kept.length !== rrset.values.length) {
          rrset.values = kept;
          touched.add(key);
        }
      }
      for (const input of additions) {
        const key = rrsetKey(input.fqdn, input.type);
        const value = toLazcoValue(input);
        const ttl = normalizeTtl(input.ttl);
        const rrset = state.get(key) ?? {
          fqdn: bare(input.fqdn),
          type: input.type,
          ttl,
          values: [],
        };
        const canonical = canonicalValue(input.type, value);
        if (!rrset.values.some((v) => canonicalValue(input.type, v) === canonical)) {
          rrset.values.push(value);
          touched.add(key);
        }
        if (rrset.values.length > 0 && ttl < rrset.ttl) {
          rrset.ttl = ttl;
          touched.add(key);
        }
        state.set(key, rrset);
      }
      const original = new Map(zone.rrsets.map((r) => [rrsetKey(r.fqdn, r.type), r]));
      return [...touched].flatMap((key): RrsetChange[] => {
        const rrset = state.get(key);
        const before = original.get(key);
        if (!rrset) return [];
        if (rrset.values.length === 0) {
          return before
            ? [{ action: "DELETE", fqdn: rrset.fqdn, type: rrset.type, expected: before.values }]
            : [];
        }
        return [
          {
            action: "REPLACE",
            fqdn: rrset.fqdn,
            type: rrset.type,
            ttl: rrset.ttl,
            values: rrset.values,
          },
        ];
      });
    };
    const { zone } = await this.write(plan);
    const find = (input: ProviderRecordInput): ProviderRecord => {
      const key = rrsetKey(input.fqdn, input.type);
      const rrset = zone.rrsets.find((r) => rrsetKey(r.fqdn, r.type) === key) ?? {
        fqdn: bare(input.fqdn),
        type: input.type,
        ttl: normalizeTtl(input.ttl),
        values: [],
      };
      return fromLazco(rrset, toLazcoValue(input));
    };
    return { created: ops.creates.map(find), replaced: ops.replaces.map((r) => find(r.input)) };
  }

  async zoneInfo(): Promise<ZoneInfo> {
    const res = await this.#request<{
      name?: string;
      rrsetCount?: number;
      limits?: { maxRrsets?: number };
    }>("GET", this.#zonePath);
    const info: ZoneInfo = {
      name: bare(String(res.body.name ?? "")),
      plan: "lazco",
      recordCount: Number(res.body.rrsetCount ?? 0),
    };
    if (typeof res.body.limits?.maxRrsets === "number") info.capacity = res.body.limits.maxRrsets;
    return info;
  }
}
