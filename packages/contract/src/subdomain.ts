import { z } from "zod";
import { IsoDateTime, SubdomainLabel, SubdomainName, Usage, Uuid } from "./primitives.ts";

export const SubdomainStatus = z.enum(["pending_review", "active", "suspended", "releasing"]);
export type SubdomainStatus = z.infer<typeof SubdomainStatus>;
export const Subdomain = z.object({
  name: SubdomainName,
  fqdn: z.string(),
  status: SubdomainStatus,
  description: z.string().max(280),
  showInDirectory: z.boolean(),
  records: Usage,
  reviewReasons: z.array(z.string()),
  suspendedReason: z.string().nullable(),
  pendingTransferId: Uuid.nullable(),
  createdAt: IsoDateTime,
  activatedAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
});
export type Subdomain = z.infer<typeof Subdomain>;

export const CreateSubdomainBody = z.object({
  name: SubdomainLabel,
  description: z.string().max(280).default(""),
  acceptTerms: z.literal(true),
  turnstileToken: z.string().min(1),
  /**
   * 合約新增（v1.2）：申請表單上顯示、使用者勾選同意的版本。帶了就必須等於目前版本；沒帶時，
   * 使用者最近一次的同意紀錄必須是目前版本，否則回 CONSENT_REQUIRED。
   */
  termsVersion: z.string().max(20).optional(),
  privacyVersion: z.string().max(20).optional(),
});
export type CreateSubdomainBody = z.infer<typeof CreateSubdomainBody>;
export const UpdateSubdomainBody = z
  .object({ description: z.string().max(280), showInDirectory: z.boolean() })
  .partial();
export type UpdateSubdomainBody = z.infer<typeof UpdateSubdomainBody>;
export const ReleaseSubdomainBody = z.object({ confirm: z.string() }); // 必須等於 name
export type ReleaseSubdomainBody = z.infer<typeof ReleaseSubdomainBody>;
