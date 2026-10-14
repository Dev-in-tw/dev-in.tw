import { z } from "zod";
import { IsoDateTime, Usage, Uuid } from "./primitives.ts";

export const Role = z.enum(["user", "admin"]);
export type Role = z.infer<typeof Role>;
export const UserStatus = z.enum(["active", "suspended"]);
export type UserStatus = z.infer<typeof UserStatus>;

/** 版本字串（例如 "1.1"）；實際值見 `CURRENT_LEGAL_VERSIONS` */
export const LegalVersion = z.string().regex(/^\d{1,3}(?:\.\d{1,3}){0,2}$/);
export type LegalVersion = z.infer<typeof LegalVersion>;
export const ConsentContext = z.enum(["login", "subdomain_create", "prompt"]);
export type ConsentContext = z.infer<typeof ConsentContext>;
/** 使用者同意的服務條款與隱私權政策版本（伺服器端紀錄） */
export const LegalConsent = z.object({
  termsVersion: LegalVersion,
  privacyVersion: LegalVersion,
  acceptedAt: IsoDateTime,
});
export type LegalConsent = z.infer<typeof LegalConsent>;
export const AcceptLegalBody = z.object({
  termsVersion: LegalVersion,
  privacyVersion: LegalVersion,
});
export type AcceptLegalBody = z.infer<typeof AcceptLegalBody>;

export const Me = z.object({
  id: Uuid,
  githubId: z.int(),
  githubLogin: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.url(),
  email: z.email().nullable(),
  role: Role,
  status: UserStatus,
  quota: z.object({ subdomains: Usage, recordsPerSubdomain: z.int() }),
  incomingTransfers: z.int().min(0),
  createdAt: IsoDateTime,
  /** 合約新增（v1.2）：最近一次同意的版本；從未同意時為 null */
  consent: LegalConsent.nullable().optional(),
  /** 合約新增（v1.2）：true 代表服務條款或隱私權政策已改版，需要重新同意（acceptLegal） */
  consentRequired: z.boolean().optional(),
});
export type Me = z.infer<typeof Me>;

export const UpdateMeBody = z
  .object({ displayName: z.string().trim().max(50).nullable() })
  .partial();
export type UpdateMeBody = z.infer<typeof UpdateMeBody>;
export const DeleteMeBody = z.object({ confirm: z.string() }); // 必須等於 githubLogin
export type DeleteMeBody = z.infer<typeof DeleteMeBody>;

export const Session = z.object({
  id: z.string(), // 對外的 opaque id（非 token hash）
  current: z.boolean(),
  userAgent: z.string().nullable(),
  ipApprox: z.string().nullable(), // 例如 "203.0.113.x"
  createdAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
});
export type Session = z.infer<typeof Session>;
