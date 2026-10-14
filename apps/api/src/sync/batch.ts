import type { ProviderRrset, RrsetChange, RrsetWriter, RrsetZone } from "./provider-port.ts";

/**
 * RRset 批次的規劃（PLAN §3.8.1），純函式。worker 把一批 outbox 工作（新增／修改、刪除、清除子網域）
 * 換算成「哪些 RRset 要變成什麼」：
 *
 * - 一個 RRset 的新內容 = 現有的值，扣掉「批次內的工作明確擁有」的值，再加上批次內新增／修改的期望值。
 * - **只移除批次內工作擁有的值**：被修改或刪除的紀錄寫過的值，以及清除中的子網域範圍內有擁有者的值。
 *   沒有擁有者的值（管理員手動建立）與擁有者已經不在 DB 的值（孤兒）一律原樣保留，交給 reconciler
 *   判斷，受大量刪除煞車保護。所以 DB 指錯或是空的時，worker 也刪不掉任何東西。
 * - 同一個 RRset 共用一個 TTL：取新內容裡所有 DB 紀錄（批次內的與沒有變動的）正規化後 TTL 的最小值；
 *   只剩下外來的值時保留原本的 TTL。
 * - 結果和現在一樣時不送；變成空的就 DELETE（帶 expectedRecords）。
 * - 送出前檢查 CNAME 排他：批次內新增的紀錄會讓同名同時有 CNAME 與其他類型時，把那幾筆排除並回報衝突，
 *   其他照常送出（Lazco DNS 整批全有或全無，一筆衝突不能拖垮整批）。
 * - 受保護的名稱（SYSTEM_RECORD_NAMES）永遠不產生變更。
 */

export interface PlannedUpsert {
  recordId: string;
  fqdn: string;
  type: string;
  /** provider 的 presentation form */
  value: string;
  /** 已經正規化（1 → 300） */
  ttl: number;
}

export interface BatchPlanInput {
  writer: Pick<RrsetWriter, "idOf">;
  /** provider id → 紀錄 id（所有權表 ∪ DB 期望值） */
  owners: ReadonlyMap<string, string>;
  upserts: readonly PlannedUpsert[];
  /** 批次內要刪除的紀錄（它們擁有的值全部移除） */
  deletes: ReadonlySet<string>;
  /** 清除中的子網域（`<sub>.<root>`）：範圍內有擁有者的值全部移除 */
  purgeApexes: readonly string[];
  /** 沒有在批次內、仍然有效的 DB 紀錄的 TTL（已正規化），用來算 RRset 的 TTL */
  ttlOf: ReadonlyMap<string, number>;
  protectedFqdns: ReadonlySet<string>;
}

export interface BatchPlan {
  changes: RrsetChange[];
  /** 因為和 DNS 上同名的其他類型衝突而排除的紀錄 */
  conflicts: Map<string, string>;
  /** 有變更的 RRset key（`<fqdn>|<TYPE>`） */
  touched: Set<string>;
}

const key = (fqdn: string, type: string) => `${fqdn.toLowerCase()}|${type.toUpperCase()}`;
const inScope = (fqdn: string, apex: string) => fqdn === apex || fqdn.endsWith(`.${apex}`);

export function planBatch(zone: RrsetZone, input: BatchPlanInput): BatchPlan {
  const conflicts = new Map<string, string>();
  for (let round = 0; round < 8; round++) {
    const upserts = input.upserts.filter((u) => !conflicts.has(u.recordId));
    const result = planOnce(zone, input, upserts);
    const found = cnameConflicts(result.state, upserts, result.touched);
    if (found.size === 0) return { changes: result.changes, conflicts, touched: result.touched };
    for (const [id, reason] of found) conflicts.set(id, reason);
  }
  // 理論上不會到這裡（每一輪至少排除一筆）；保守起見只送刪除
  const result = planOnce(zone, input, []);
  for (const u of input.upserts) if (!conflicts.has(u.recordId)) conflicts.set(u.recordId, "衝突");
  return { changes: result.changes, conflicts, touched: result.touched };
}

function planOnce(zone: RrsetZone, input: BatchPlanInput, upserts: readonly PlannedUpsert[]) {
  const inBatch = new Set([...upserts.map((u) => u.recordId), ...input.deletes]);
  const current = new Map<string, ProviderRrset>(zone.rrsets.map((r) => [key(r.fqdn, r.type), r]));
  const upsertsByKey = new Map<string, PlannedUpsert[]>();
  for (const u of upserts) {
    const k = key(u.fqdn, u.type);
    const list = upsertsByKey.get(k) ?? [];
    list.push(u);
    upsertsByKey.set(k, list);
  }

  // 要重算的 RRset：批次內新增／修改的目的地，以及含有「批次內工作擁有的值」的 RRset
  const candidates = new Set(upsertsByKey.keys());
  for (const [k, rrset] of current) {
    const purged = input.purgeApexes.some((apex) => inScope(rrset.fqdn, apex));
    for (const value of rrset.values) {
      const owner = input.owners.get(input.writer.idOf(rrset.fqdn, rrset.type, value));
      if (owner && (inBatch.has(owner) || purged)) candidates.add(k);
    }
  }

  const changes: RrsetChange[] = [];
  const touched = new Set<string>();
  const state = new Map(current);
  for (const k of candidates) {
    const before = current.get(k);
    const first = upsertsByKey.get(k)?.[0];
    const fqdn = before?.fqdn ?? first?.fqdn ?? "";
    const type = before?.type ?? first?.type ?? "";
    if (input.protectedFqdns.has(fqdn)) continue;
    const purged = input.purgeApexes.some((apex) => inScope(fqdn, apex));

    const next: string[] = [];
    const seen = new Set<string>();
    const ttls: number[] = [];
    const push = (value: string) => {
      const id = input.writer.idOf(fqdn, type, value);
      if (seen.has(id)) return;
      seen.add(id);
      next.push(value);
    };
    for (const value of before?.values ?? []) {
      const owner = input.owners.get(input.writer.idOf(fqdn, type, value));
      if (owner && (inBatch.has(owner) || purged)) continue;
      push(value);
      const ttl = owner ? input.ttlOf.get(owner) : undefined;
      if (ttl !== undefined) ttls.push(ttl);
    }
    if (!purged) {
      for (const u of upsertsByKey.get(k) ?? []) {
        push(u.value);
        ttls.push(u.ttl);
      }
    }
    const ttl = ttls.length > 0 ? Math.min(...ttls) : (before?.ttl ?? 300);

    if (next.length === 0) {
      if (before) {
        changes.push({ action: "DELETE", fqdn, type, expected: [...before.values] });
        touched.add(k);
        state.delete(k);
      }
      continue;
    }
    const same =
      before !== undefined &&
      before.ttl === ttl &&
      before.values.length === next.length &&
      before.values.every((v) => seen.has(input.writer.idOf(fqdn, type, v)));
    if (same) continue;
    changes.push({ action: "REPLACE", fqdn, type, ttl, values: next });
    touched.add(k);
    state.set(k, { fqdn, type, ttl, values: next });
  }
  return { changes, touched, state };
}

/** 同名同時有 CNAME 與其他類型、而且是批次內新增造成的：回傳要排除的紀錄 */
function cnameConflicts(
  state: ReadonlyMap<string, ProviderRrset>,
  upserts: readonly PlannedUpsert[],
  touched: ReadonlySet<string>,
): Map<string, string> {
  const types = new Map<string, Set<string>>();
  for (const r of state.values()) {
    const set = types.get(r.fqdn) ?? new Set<string>();
    set.add(r.type);
    types.set(r.fqdn, set);
  }
  const out = new Map<string, string>();
  for (const u of upserts) {
    if (!touched.has(key(u.fqdn, u.type))) continue;
    const present = types.get(u.fqdn);
    if (!present?.has("CNAME") || present.size <= 1) continue;
    out.set(
      u.recordId,
      u.type === "CNAME"
        ? "DNS 上同名已有其他類型的紀錄，不能再加 CNAME"
        : "DNS 上同名已有 CNAME，不能再加其他類型的紀錄",
    );
  }
  return out;
}
