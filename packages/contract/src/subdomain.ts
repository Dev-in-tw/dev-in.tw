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
});
export type CreateSubdomainBody = z.infer<typeof CreateSubdomainBody>;
export const UpdateSubdomainBody = z
  .object({ description: z.string().max(280), showInDirectory: z.boolean() })
  .partial();
export type UpdateSubdomainBody = z.infer<typeof UpdateSubdomainBody>;
export const ReleaseSubdomainBody = z.object({ confirm: z.string() }); // 必須等於 name
export type ReleaseSubdomainBody = z.infer<typeof ReleaseSubdomainBody>;
