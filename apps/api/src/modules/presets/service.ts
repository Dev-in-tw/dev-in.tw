import type {
  DnsRecord,
  Preset,
  PresetBody,
  PresetId,
  PresetPlan,
  RecordInput,
} from "@dit/contract";
import { PRESETS, planPreset, validateRecord } from "@dit/dns";
import { eq } from "drizzle-orm";
import type { Actor, Deps } from "../../context.ts";
import type { Executor } from "../../db/client.ts";
import type { RecordRow, SubdomainRow, UserRow } from "../../db/schema.ts";
import { subdomains } from "../../db/schema.ts";
import { AppError } from "../../lib/problem.ts";
import { wakeWorker } from "../../sync/events-bus.ts";
import { writeAudit } from "../audit/service.ts";
import { recordDto } from "../dto.ts";
import { userLimits } from "../quota.ts";
import { normalizeRecordInput } from "../records/normalize.ts";
import {
  assertActive,
  assertZoneCapacity,
  insertRecord,
  liveRecords,
  markRecordDeleting,
  verdictError,
} from "../records/service.ts";
import { loadOwnedSubdomain } from "../subdomains/service.ts";

/**
 * packages/dns 的 PRESETS 的 available 是合約初版（只有 P0 平台）的狀態；後端的 planPreset
 * 已實作全部 10 個 preset，所以對外一律回 available: true。
 */
export function listPresets(): Preset[] {
  return PRESETS.map((p) => ({ ...p, available: true }) as Preset);
}

interface ComputedPlan {
  creates: RecordInput[];
  deletes: RecordRow[];
  warnings: string[];
}

async function computePlan(
  ex: Executor,
  deps: Pick<Deps, "config">,
  user: UserRow,
  sub: SubdomainRow,
  presetId: PresetId,
  body: PresetBody,
): Promise<ComputedPlan> {
  const root = deps.config.ROOT_DOMAIN;
  const existing = await liveRecords(ex, sub.id);
  const existingDtos = existing.map((r) => recordDto(r, sub.name, root));
  const result = planPreset(presetId, body.params, {
    sub: sub.name,
    root,
    recordName: body.recordName,
    githubLogin: user.githubLogin,
    existing: existingDtos,
  });
  if ("ok" in result) {
    throw verdictError(result, "PRESET_PARAMS_INVALID") ?? new AppError("PRESET_PARAMS_INVALID");
  }
  const deleteIds = new Set(result.deletes.map((d) => d.id));
  const deletes = existing.filter((r) => deleteIds.has(r.id));
  const creates = result.creates.map(normalizeRecordInput);

  // 依序模擬：刪除之後的紀錄集合，再一筆一筆加入 creates，用完整規則檢查（含 CNAME 擁有權）
  const owned = (
    await ex
      .select({ name: subdomains.name })
      .from(subdomains)
      .where(eq(subdomains.ownerId, user.id))
  ).map((r) => r.name);
  const simulated: DnsRecord[] = existingDtos.filter((r) => !deleteIds.has(r.id));
  for (const [index, create] of creates.entries()) {
    const verdict = validateRecord(create, {
      sub: sub.name,
      root,
      existing: simulated,
      ownedSubdomains: owned,
      allowedTypes: deps.config.ALLOWED_RECORD_TYPES,
      provider: deps.config.DNS_PROVIDER,
    });
    const error = verdictError(verdict, "PRESET_PARAMS_INVALID");
    if (error) {
      throw new AppError("PRESET_PARAMS_INVALID", error.detail, {
        errors: (verdict.ok ? [] : verdict.violations).map((v) => ({
          ...v,
          path: `creates.${index}.${v.path}`,
        })),
      });
    }
    simulated.push({
      ...create,
      id: `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
      fqdn: "",
      version: 1,
      syncStatus: "pending",
      syncError: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    } as DnsRecord);
  }
  return { creates, deletes, warnings: result.warnings };
}

export async function planPresetFor(
  deps: Deps,
  user: UserRow,
  name: string,
  presetId: PresetId,
  body: PresetBody,
): Promise<PresetPlan> {
  const sub = await loadOwnedSubdomain(deps.db, user.id, name);
  const plan = await computePlan(deps.db, deps, user, sub, presetId, body);
  return {
    creates: plan.creates,
    deletes: plan.deletes.map((r) => recordDto(r, sub.name, deps.config.ROOT_DOMAIN)),
    warnings: plan.warnings,
  };
}

export async function applyPreset(
  deps: Deps,
  user: UserRow,
  name: string,
  presetId: PresetId,
  body: PresetBody,
  actor: Actor,
): Promise<{ created: DnsRecord[]; deletedIds: string[] }> {
  return deps.db.transaction(async (tx) => {
    const sub = await loadOwnedSubdomain(tx, user.id, name, { forUpdate: true });
    assertActive(sub);
    const plan = await computePlan(tx, deps, user, sub, presetId, body);
    const live = (await liveRecords(tx, sub.id)).length;
    const limit = userLimits(user, deps.config).records;
    if (live - plan.deletes.length + plan.creates.length > limit) {
      throw new AppError("RECORD_QUOTA_EXCEEDED", `每個子網域最多 ${limit} 筆紀錄`);
    }
    await assertZoneCapacity(tx, deps, plan.creates.length - plan.deletes.length);
    for (const record of plan.deletes) await markRecordDeleting(tx, deps, record);
    const created: RecordRow[] = [];
    for (const input of plan.creates) created.push(await insertRecord(tx, deps, sub, input));
    await writeAudit(tx, actor, {
      action: "preset.apply",
      targetType: "subdomain",
      targetId: sub.id,
      targetLabel: `${sub.name}.${deps.config.ROOT_DOMAIN}`,
      metadata: {
        presetId,
        recordName: body.recordName,
        created: created.map((r) => r.id),
        deleted: plan.deletes.map((r) => r.id),
      },
    });
    await wakeWorker(tx);
    return {
      created: created.map((r) => recordDto(r, sub.name, deps.config.ROOT_DOMAIN)),
      deletedIds: plan.deletes.map((r) => r.id),
    };
  });
}
