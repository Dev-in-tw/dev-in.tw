import {
  type ConsentContext,
  CURRENT_LEGAL_VERSIONS,
  isCurrentConsent,
  type LegalConsent,
  type LegalVersions,
} from "@dit/contract";
import { desc, eq } from "drizzle-orm";
import type { Actor, Deps } from "../../context.ts";
import type { Executor } from "../../db/client.ts";
import { type ConsentRow, legalConsents, type UserRow } from "../../db/schema.ts";
import { uuidv7 } from "../../lib/ids.ts";
import { AppError } from "../../lib/problem.ts";
import { writeAudit } from "../audit/service.ts";
import { iso } from "../dto.ts";

/**
 * 同意紀錄（服務條款第 1 條、隱私權政策第 2 條）：首次登入、申請子網域、條款改版後重新同意時，
 * 記錄使用者同意的版本與時間。版本來源是 `@dit/contract/legal`，與網站顯示的版本相同。
 * 不記錄 IP 或 User-Agent；帳號刪除時一併刪除。
 */
export async function latestConsent(ex: Executor, userId: string): Promise<ConsentRow | null> {
  const [row] = await ex
    .select()
    .from(legalConsents)
    .where(eq(legalConsents.userId, userId))
    .orderBy(desc(legalConsents.seq))
    .limit(1);
  return row ?? null;
}

export function consentDto(row: ConsentRow): LegalConsent {
  return {
    termsVersion: row.termsVersion,
    privacyVersion: row.privacyVersion,
    acceptedAt: iso(row.acceptedAt),
  };
}

/** 使用者送來的版本是否就是目前版本（兩個都帶、都相同） */
type MaybeVersions = { termsVersion?: string | undefined; privacyVersion?: string | undefined };

export function matchesCurrent(versions: MaybeVersions): versions is LegalVersions {
  return (
    versions.termsVersion !== undefined &&
    versions.privacyVersion !== undefined &&
    isCurrentConsent(versions as LegalVersions)
  );
}

export async function recordConsent(
  ex: Executor,
  userId: string,
  context: ConsentContext,
  now: Date,
): Promise<ConsentRow> {
  const [row] = await ex
    .insert(legalConsents)
    .values({
      id: uuidv7(now.getTime()),
      userId,
      termsVersion: CURRENT_LEGAL_VERSIONS.termsVersion,
      privacyVersion: CURRENT_LEGAL_VERSIONS.privacyVersion,
      context,
      acceptedAt: now,
    })
    .returning();
  if (!row) throw new Error("consent insert returned no row");
  return row;
}

const CONSENT_MESSAGE = "服務條款或隱私權政策已更新，請重新整理頁面，閱讀並同意最新版本後再試一次";

/** POST /me/consent：只接受目前版本（前端拿的是舊版本時，請使用者重新整理後再同意） */
export async function acceptLegal(
  deps: Deps,
  user: UserRow,
  body: LegalVersions,
  actor: Actor,
): Promise<LegalConsent> {
  if (!matchesCurrent(body)) throw new AppError("CONSENT_REQUIRED", CONSENT_MESSAGE);
  return deps.db.transaction(async (tx) => {
    const row = await recordConsent(tx, user.id, "prompt", deps.clock.now());
    await writeAudit(tx, actor, {
      action: "legal.accept",
      targetType: "user",
      targetId: user.id,
      targetLabel: user.githubLogin,
      metadata: { ...CURRENT_LEGAL_VERSIONS, context: "prompt" },
    });
    return consentDto(row);
  });
}

/**
 * 申請子網域時的同意：表單帶了版本就必須是目前版本（回傳 true，呼叫端在建立子網域的交易裡記錄一筆
 * subdomain_create）；沒帶時（舊版前端），最近一次的同意紀錄必須是目前版本。都不符合就回
 * CONSENT_REQUIRED。在驗證 Turnstile 之前呼叫，避免浪費使用者的人機驗證。
 */
export async function checkSubdomainConsent(
  ex: Executor,
  user: UserRow,
  versions: MaybeVersions,
): Promise<boolean> {
  if (versions.termsVersion !== undefined || versions.privacyVersion !== undefined) {
    if (!matchesCurrent(versions)) throw new AppError("CONSENT_REQUIRED", CONSENT_MESSAGE);
    return true;
  }
  if (!isCurrentConsent(await latestConsent(ex, user.id))) {
    throw new AppError("CONSENT_REQUIRED", CONSENT_MESSAGE);
  }
  return false;
}
