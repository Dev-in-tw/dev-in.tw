import { randomBytes } from "node:crypto";
import { ProviderError } from "../../sync/errors.ts";
import type {
  BatchOps,
  DnsProvider,
  ProviderRecord,
  ProviderRecordInput,
  ZoneInfo,
} from "../../sync/provider-port.ts";

type Op = "create" | "replace" | "delete" | "batch" | "list" | "zone";

/**
 * 記憶體版 DnsProvider（本機開發與測試，`DNS_PROVIDER=memory`）。
 * 行為盡量貼近 Cloudflare：同名 CNAME 與其他紀錄互斥、紀錄數上限、batch all-or-nothing。
 * 測試可以注入錯誤（failNext）與「寫入成功但回應逾時」（timeoutAfterCreate）。
 */
export class MemoryDnsProvider implements DnsProvider {
  readonly kind = "memory" as const;
  readonly supportsComments = true;
  readonly records = new Map<string, ProviderRecord>();
  readonly calls: { op: Op; detail?: string }[] = [];
  readonly #zoneName: string;
  readonly #limit: number;
  readonly #failures: { op: Op | "any"; error: ProviderError }[] = [];
  #timeoutAfterCreate = 0;

  constructor(opts: { zoneName: string; recordLimit?: number }) {
    this.#zoneName = opts.zoneName;
    this.#limit = opts.recordLimit ?? 1000;
  }

  /** 下一次（符合 op 的）呼叫丟出指定錯誤 */
  failNext(op: Op | "any", error: ProviderError, times = 1): void {
    for (let i = 0; i < times; i++) this.#failures.push({ op, error });
  }

  /** 接下來 n 次 create 會真的寫入，但回應時丟出逾時錯誤 */
  timeoutAfterCreate(times = 1): void {
    this.#timeoutAfterCreate += times;
  }

  /** 直接塞一筆紀錄（模擬手動建立的系統紀錄或孤兒） */
  seed(input: Omit<ProviderRecordInput, "comment"> & { comment?: string | null }): ProviderRecord {
    const record = this.#materialize(input as ProviderRecordInput, input.comment ?? null);
    this.records.set(record.id, record);
    return record;
  }

  #maybeFail(op: Op): void {
    const index = this.#failures.findIndex((f) => f.op === op || f.op === "any");
    if (index >= 0) {
      const [failure] = this.#failures.splice(index, 1);
      if (failure) throw failure.error;
    }
  }

  #materialize(input: ProviderRecordInput, comment: string | null, id?: string): ProviderRecord {
    const record: ProviderRecord = {
      id: id ?? randomBytes(16).toString("hex"),
      fqdn: input.fqdn.toLowerCase(),
      type: input.type,
      ttl: input.ttl,
      comment,
      modifiedAt: new Date().toISOString(),
    };
    if (input.content !== undefined) record.content = input.content;
    if (input.priority !== undefined) record.priority = input.priority;
    if (input.data !== undefined) record.data = { ...input.data };
    return record;
  }

  #assertWritable(
    input: ProviderRecordInput,
    state: Map<string, ProviderRecord>,
    ignoreId?: string,
  ) {
    const fqdn = input.fqdn.toLowerCase();
    if (fqdn !== this.#zoneName && !fqdn.endsWith(`.${this.#zoneName}`)) {
      throw new ProviderError("permanent", "mem:out_of_zone", "紀錄名稱不在 zone 範圍內", 400);
    }
    for (const r of state.values()) {
      if (r.id === ignoreId || r.fqdn !== fqdn) continue;
      if (r.type === "CNAME" || input.type === "CNAME") {
        throw new ProviderError(
          "permanent",
          "mem:cname_conflict",
          "同名已有其他紀錄，與 CNAME 衝突",
          400,
        );
      }
      if (
        r.type === input.type &&
        r.content === input.content &&
        r.priority === input.priority &&
        JSON.stringify(r.data ?? null) === JSON.stringify(input.data ?? null)
      ) {
        throw new ProviderError("permanent", "mem:duplicate", "已存在相同的紀錄", 400);
      }
    }
  }

  async *listAll(): AsyncIterable<ProviderRecord> {
    this.calls.push({ op: "list" });
    this.#maybeFail("list");
    for (const r of [...this.records.values()]) yield { ...r };
  }

  async findByComment(comment: string): Promise<ProviderRecord | null> {
    this.calls.push({ op: "list", detail: comment });
    this.#maybeFail("list");
    for (const r of this.records.values()) if (r.comment === comment) return { ...r };
    return null;
  }

  async create(input: ProviderRecordInput): Promise<ProviderRecord> {
    this.calls.push({ op: "create", detail: `${input.type} ${input.fqdn}` });
    this.#maybeFail("create");
    if (this.records.size >= this.#limit) {
      throw new ProviderError("capacity", "mem:quota", "zone 紀錄數已達上限", 400);
    }
    this.#assertWritable(input, this.records);
    const record = this.#materialize(input, input.comment);
    this.records.set(record.id, record);
    if (this.#timeoutAfterCreate > 0) {
      this.#timeoutAfterCreate--;
      throw new ProviderError("transient", "timeout", "DNS 服務回應逾時，系統會自動重試");
    }
    return { ...record };
  }

  async replace(id: string, input: ProviderRecordInput): Promise<ProviderRecord> {
    this.calls.push({ op: "replace", detail: `${input.type} ${input.fqdn}` });
    this.#maybeFail("replace");
    const current = this.records.get(id);
    if (!current) throw new ProviderError("not_found", "mem:not_found", "找不到紀錄", 404);
    if (current.type !== input.type) {
      throw new ProviderError("permanent", "mem:type_change", "不能就地修改紀錄類型", 400);
    }
    this.#assertWritable(input, this.records, id);
    const record = this.#materialize(input, input.comment, id);
    this.records.set(id, record);
    return { ...record };
  }

  async delete(id: string): Promise<void> {
    this.calls.push({ op: "delete", detail: id });
    this.#maybeFail("delete");
    this.records.delete(id);
  }

  async batch(ops: BatchOps): Promise<{ created: ProviderRecord[]; replaced: ProviderRecord[] }> {
    this.calls.push({
      op: "batch",
      detail: `-${ops.deletes.length} ~${ops.replaces.length} +${ops.creates.length}`,
    });
    this.#maybeFail("batch");
    const next = new Map(this.records);
    for (const id of ops.deletes) next.delete(id);
    const replaced: ProviderRecord[] = [];
    for (const { id, input } of ops.replaces) {
      const current = next.get(id);
      if (!current || current.type !== input.type) {
        throw new ProviderError("permanent", "mem:batch_replace", "batch 內的修改不合法", 400);
      }
      this.#assertWritable(input, next, id);
      const record = this.#materialize(input, input.comment, id);
      next.set(id, record);
      replaced.push(record);
    }
    const created: ProviderRecord[] = [];
    for (const input of ops.creates) {
      if (next.size >= this.#limit) {
        throw new ProviderError("capacity", "mem:quota", "zone 紀錄數已達上限", 400);
      }
      this.#assertWritable(input, next);
      const record = this.#materialize(input, input.comment);
      next.set(record.id, record);
      created.push(record);
    }
    this.records.clear();
    for (const [id, r] of next) this.records.set(id, r);
    return { created: created.map((r) => ({ ...r })), replaced: replaced.map((r) => ({ ...r })) };
  }

  async zoneInfo(): Promise<ZoneInfo> {
    this.calls.push({ op: "zone" });
    this.#maybeFail("zone");
    return { name: this.#zoneName, plan: "memory", recordCount: this.records.size };
  }
}
