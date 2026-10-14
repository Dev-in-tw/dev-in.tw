import { z } from "zod";
import { DnsRecord } from "./dns.ts";
import { IsoDateTime, SubdomainName, Uuid } from "./primitives.ts";
import { ReportCategory, ReportStatus } from "./report.ts";
import { Subdomain } from "./subdomain.ts";
import { TransferStatus } from "./transfer.ts";
import { ConsentContext, LegalVersion, Role, UserStatus } from "./user.ts";

/**
 * 個人資料匯出（GET /me/export，合約 v1.2 新增）：使用者自己的資料，依個資法第 3 條「製給複製本」。
 *
 * 只放這個使用者本人的資料：不含其他使用者的 email、IP 或 id（轉移對象與稽核紀錄只出現 GitHub
 * 帳號名稱這類公開資訊），也不含任何機密（session token 與其雜湊、OAuth 資料、管理員的處理備註）。
 */
export const DATA_EXPORT_FORMAT = "dev-in.tw/user-data-export@1";

export const ExportAccount = z.object({
  id: Uuid,
  githubId: z.int(),
  githubLogin: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.url(),
  email: z.email().nullable(),
  githubCreatedAt: IsoDateTime,
  role: Role,
  status: UserStatus,
  suspendedReason: z.string().nullable(),
  createdAt: IsoDateTime,
  lastLoginAt: IsoDateTime,
});
export type ExportAccount = z.infer<typeof ExportAccount>;

export const ExportRecord = DnsRecord.and(z.object({ subdomain: SubdomainName }));
export type ExportRecord = z.infer<typeof ExportRecord>;

export const ExportActivity = z.object({
  id: Uuid,
  action: z.string(),
  /** 這筆操作是誰做的：user 是你本人；admin 與 system 不揭露是哪位管理員 */
  actorType: z.enum(["user", "admin", "system"]),
  target: z.object({ type: z.string(), id: z.string(), label: z.string() }),
  metadata: z.record(z.string(), z.unknown()),
  /** 你本人操作時的 IP；90 天後清除，非本人的操作一律為 null */
  ip: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type ExportActivity = z.infer<typeof ExportActivity>;

export const ExportSession = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  idleExpiresAt: IsoDateTime,
  absoluteExpiresAt: IsoDateTime,
  revokedAt: IsoDateTime.nullable(),
});
export type ExportSession = z.infer<typeof ExportSession>;

export const ExportTransfer = z.object({
  id: Uuid,
  subdomain: z.string().nullable(),
  direction: z.enum(["outgoing", "incoming"]),
  /** 對方的 GitHub 帳號名稱（公開資訊）；對方帳號已刪除時為 null */
  counterpart: z.string().nullable(),
  status: TransferStatus,
  keepRecords: z.boolean(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
});
export type ExportTransfer = z.infer<typeof ExportTransfer>;

export const ExportConsent = z.object({
  termsVersion: LegalVersion,
  privacyVersion: LegalVersion,
  context: ConsentContext,
  acceptedAt: IsoDateTime,
});
export type ExportConsent = z.infer<typeof ExportConsent>;

/** 你登入時送出的檢舉（只有你填寫的內容與處理狀態，不含管理員的處理備註） */
export const ExportReport = z.object({
  id: Uuid,
  subdomain: z.string(),
  category: ReportCategory,
  details: z.string(),
  contactEmail: z.email().nullable(),
  status: ReportStatus,
  createdAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
});
export type ExportReport = z.infer<typeof ExportReport>;

export const UserDataExport = z.object({
  format: z.literal(DATA_EXPORT_FORMAT),
  generatedAt: IsoDateTime,
  account: ExportAccount,
  subdomains: z.array(Subdomain),
  records: z.array(ExportRecord),
  activity: z.array(ExportActivity),
  sessions: z.array(ExportSession),
  transfers: z.array(ExportTransfer),
  consents: z.array(ExportConsent),
  reports: z.array(ExportReport),
});
export type UserDataExport = z.infer<typeof UserDataExport>;
