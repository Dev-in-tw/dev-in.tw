import { eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { settings } from "../db/schema.ts";

export type ReviewMode = "risk" | "all" | "none";

export interface ZoneSnapshot {
  recordCount: number;
  /** provider 上沒有 dit: 標記的紀錄數（系統紀錄、手動建立的紀錄） */
  unmanagedCount: number;
  plan: string | null;
  at: string;
}

export interface DriftItem {
  kind: "missing" | "modified" | "orphan" | "unmanaged";
  fqdn: string;
  type: string;
  detail: string;
}

export interface ReconcileReport {
  at: string;
  outcome: "ok" | "blocked" | "failed";
  forced: boolean;
  drift: DriftItem[];
  orphansDeleted: number;
  /** 被大量刪除煞車擋下時的說明 */
  blockedReason: string | null;
}

export interface SettingsShape {
  registration_open: boolean;
  review_mode: ReviewMode;
  zone_snapshot: ZoneSnapshot | null;
  reconcile_report: ReconcileReport | null;
}

const DEFAULTS: SettingsShape = {
  registration_open: true,
  review_mode: "risk",
  zone_snapshot: null,
  reconcile_report: null,
};

export async function getSettings<K extends keyof SettingsShape>(
  ex: Executor,
  keys: readonly K[],
): Promise<Pick<SettingsShape, K>> {
  const rows = await ex
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, keys as unknown as string[]));
  const out = {} as Pick<SettingsShape, K>;
  for (const key of keys) {
    const row = rows.find((r) => r.key === key);
    out[key] = (row ? row.value : DEFAULTS[key]) as SettingsShape[K];
  }
  return out;
}

export async function getSetting<K extends keyof SettingsShape>(
  ex: Executor,
  key: K,
): Promise<SettingsShape[K]> {
  return (await getSettings(ex, [key]))[key];
}

export async function setSetting<K extends keyof SettingsShape>(
  ex: Executor,
  key: K,
  value: SettingsShape[K],
): Promise<void> {
  await ex
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`now()` } });
}

export async function deleteSetting(ex: Executor, key: keyof SettingsShape): Promise<void> {
  await ex.delete(settings).where(eq(settings.key, key));
}
