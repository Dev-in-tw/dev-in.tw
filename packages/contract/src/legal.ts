/**
 * 法務文件（服務條款、隱私權政策、使用規範）目前的版本與生效日期：前端顯示與後端記錄同意紀錄的
 * 單一來源。這個檔案刻意不依賴 zod，前端的 client component 可以透過 `@dit/contract/legal`
 * 匯入而不會把 schema 打包進 bundle。
 *
 * 修改條文時：調整 version 與 effective，並在文件最後的「修訂紀錄」補一行。terms 或 privacy 的
 * version 改變後，已登入的使用者下次操作時會被要求重新同意（`Me.consentRequired`）。
 */
export const LEGAL_DOCUMENTS = {
  terms: { version: "1.0", effective: "2026-10-14" },
  privacy: { version: "1.1", effective: "2026-10-14" },
  aup: { version: "1.1", effective: "2026-10-14" },
} as const;

export type LegalDocumentId = keyof typeof LEGAL_DOCUMENTS;

/** 需要使用者明示同意的版本（使用規範是服務條款的一部分，跟著服務條款一起同意） */
export const CURRENT_LEGAL_VERSIONS = {
  termsVersion: LEGAL_DOCUMENTS.terms.version,
  privacyVersion: LEGAL_DOCUMENTS.privacy.version,
} as const;

export type LegalVersions = { termsVersion: string; privacyVersion: string };

/** 同意紀錄是否對應目前的服務條款與隱私權政策版本 */
export function isCurrentConsent(consent: LegalVersions | null | undefined): boolean {
  return (
    !!consent &&
    consent.termsVersion === CURRENT_LEGAL_VERSIONS.termsVersion &&
    consent.privacyVersion === CURRENT_LEGAL_VERSIONS.privacyVersion
  );
}
