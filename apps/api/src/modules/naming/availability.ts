import type { Availability, AvailabilityStatus } from "@dit/contract";
import { SUBDOMAIN_LABEL_RE } from "@dit/contract";
import { checkLabelSyntax, confusableWith, isPremiumLength, normalizeLabel } from "@dit/dns";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { Config } from "../../config.ts";
import type { Executor } from "../../db/client.ts";
import { nameHolds, reservedNames, subdomains, type UserRow } from "../../db/schema.ts";
import { DAY } from "../../lib/clock.ts";
import { zoneUsage } from "../quota.ts";
import { getSetting } from "../settings.ts";

const RESERVED_REASON: Record<string, string> = {
  system: "這是系統保留名稱",
  brand: "這是品牌保留名稱",
  offensive: "這個名稱不開放申請",
  premium: "這是保留名稱，不開放一般申請",
  zone: "這個名稱已被系統使用",
};

export interface NameDecision {
  name: string;
  status: AvailabilityStatus;
  reason?: string;
  reviewReasons: string[];
}

async function loadBrands(ex: Executor): Promise<string[]> {
  const rows = await ex
    .select({ name: reservedNames.name })
    .from(reservedNames)
    .where(eq(reservedNames.category, "brand"));
  return rows.map((r) => r.name.toLowerCase());
}

/**
 * 名稱判定（PLAN §3.9 的順序）：格式 → 保留字（含 zone 既有名稱）→ 已註冊 → 冷卻期 → 全域容量 → 風險。
 * 風險不阻擋申請，只會讓子網域進入 pending_review。
 */
export async function decideName(
  ex: Executor,
  config: Config,
  rawName: string,
  viewer: Pick<UserRow, "githubCreatedAt"> | null,
  now: Date,
): Promise<NameDecision> {
  const name = normalizeLabel(rawName);
  const out = (status: AvailabilityStatus, reason?: string, reviewReasons: string[] = []) => ({
    name,
    status,
    ...(reason !== undefined ? { reason } : {}),
    reviewReasons,
  });

  if (isPremiumLength(name)) return out("reserved", RESERVED_REASON.premium);
  const syntax = checkLabelSyntax(name);
  if (!syntax.ok) return out("invalid", syntax.violations[0]?.message ?? "名稱格式不正確");

  const [reserved] = await ex
    .select({ category: reservedNames.category })
    .from(reservedNames)
    .where(eq(reservedNames.name, name))
    .limit(1);
  if (reserved) return out("reserved", RESERVED_REASON[reserved.category]);

  const [taken] = await ex
    .select({ id: subdomains.id })
    .from(subdomains)
    .where(eq(subdomains.name, name))
    .limit(1);
  if (taken) return out("taken", "這個名稱已經有人使用");

  const [hold] = await ex
    .select({ holdUntil: nameHolds.holdUntil })
    .from(nameHolds)
    .where(and(eq(nameHolds.name, name), gt(nameHolds.holdUntil, now)))
    .limit(1);
  if (hold) {
    const days = Math.max(1, Math.ceil((hold.holdUntil.getTime() - now.getTime()) / DAY));
    return out("cooldown", `這個名稱剛被釋出，約 ${days} 天後才能申請`);
  }

  const usage = await zoneUsage(ex, config);
  if (usage.used >= usage.usable) return out("capacity_full", "目前名額已滿，請稍後再試");

  const reviewMode = await getSetting(ex, "review_mode");
  if (reviewMode === "none") return out("available");
  const reasons: string[] = [];
  const brand = confusableWith(name, await loadBrands(ex));
  if (brand) reasons.push(`confusable:${brand}`);
  if (viewer) {
    const ageDays = (now.getTime() - viewer.githubCreatedAt.getTime()) / DAY;
    if (ageDays < config.MIN_GITHUB_ACCOUNT_AGE_DAYS) reasons.push("account_too_new");
  }
  if (reviewMode === "all") reasons.push("review_all");
  if (reasons.length > 0) {
    const reason = brand
      ? "名稱和知名品牌相似，送出後需要人工審核"
      : reasons.includes("account_too_new")
        ? "GitHub 帳號建立未滿 30 天，送出後需要人工審核"
        : "送出後需要人工審核";
    return out("review", reason, reasons);
  }
  return out("available");
}

/** 把不合法的輸入盡量修成合法的 label（給建議名稱用） */
function sanitize(name: string): string {
  return name
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

async function suggest(
  ex: Executor,
  config: Config,
  base: string,
  viewer: Pick<UserRow, "githubCreatedAt" | "githubLogin"> | null,
  now: Date,
): Promise<string[]> {
  const root = sanitize(base);
  const raw = [
    root,
    `${root}-dev`,
    `${root}tw`,
    `${root}-tw`,
    `my-${root}`,
    `${root}-site`,
    viewer ? sanitize(viewer.githubLogin.toLowerCase()) : "",
    viewer ? `${sanitize(viewer.githubLogin.toLowerCase())}-dev` : "",
  ];
  const candidates = [...new Set(raw)].filter((c) => c && c !== base && SUBDOMAIN_LABEL_RE.test(c));
  if (candidates.length === 0) return [];
  // 一次排除保留字、已註冊與冷卻中的名稱，再逐一檢查品牌近似
  const [reserved, taken, held] = await Promise.all([
    ex
      .select({ n: reservedNames.name })
      .from(reservedNames)
      .where(inArray(reservedNames.name, candidates)),
    ex.select({ n: subdomains.name }).from(subdomains).where(inArray(subdomains.name, candidates)),
    ex
      .select({ n: nameHolds.name })
      .from(nameHolds)
      .where(and(inArray(nameHolds.name, candidates), gt(nameHolds.holdUntil, now))),
  ]);
  const blocked = new Set([...reserved, ...taken, ...held].map((r) => r.n.toLowerCase()));
  const brands = await loadBrands(ex);
  void config;
  return candidates
    .filter((c) => !blocked.has(c) && confusableWith(c, brands) === null)
    .slice(0, 5);
}

export async function checkAvailability(
  ex: Executor,
  config: Config,
  rawName: string,
  viewer: UserRow | null,
  now: Date,
): Promise<Availability> {
  const decision = await decideName(ex, config, rawName, viewer, now);
  const fqdn = `${decision.name}.${config.ROOT_DOMAIN}`;
  const result: Availability = {
    name: decision.name,
    fqdn,
    status: decision.status,
    suggestions:
      decision.status === "available" || decision.status === "capacity_full"
        ? []
        : await suggest(ex, config, decision.name, viewer, now),
  };
  if (decision.reason !== undefined) result.reason = decision.reason;
  if (decision.status === "review") result.reviewReasons = decision.reviewReasons;
  return result;
}
