import { z } from "zod";
import { IsoDateTime, PageQuery, PublicUser, Usage, Uuid } from "./primitives.ts";
import { ReportCategory, ReportStatus } from "./report.ts";
import { Subdomain } from "./subdomain.ts";
import { Role, UserStatus } from "./user.ts";

export const AdminUser = z.object({
  id: Uuid,
  githubId: z.int(),
  githubLogin: z.string(),
  avatarUrl: z.url(),
  email: z.email().nullable(),
  role: Role,
  status: UserStatus,
  suspendedReason: z.string().nullable(),
  githubCreatedAt: IsoDateTime,
  subdomainCount: z.int(),
  quotaOverride: z
    .object({ subdomains: z.int().nullable(), recordsPerSubdomain: z.int().nullable() })
    .nullable(),
  createdAt: IsoDateTime,
  lastLoginAt: IsoDateTime,
});
export type AdminUser = z.infer<typeof AdminUser>;
export const AdminUpdateUserBody = z
  .object({
    status: UserStatus,
    reason: z.string().max(500),
    quotaOverride: z
      .object({
        subdomains: z.int().min(0).nullable(),
        recordsPerSubdomain: z.int().min(0).nullable(),
      })
      .nullable(),
  })
  .partial();
export type AdminUpdateUserBody = z.infer<typeof AdminUpdateUserBody>;
export const AdminSubdomain = Subdomain.extend({
  owner: PublicUser.extend({ id: Uuid, githubCreatedAt: IsoDateTime }),
});
export type AdminSubdomain = z.infer<typeof AdminSubdomain>;
export const AdminDecisionBody = z.object({ reason: z.string().max(500).optional() });
export type AdminDecisionBody = z.infer<typeof AdminDecisionBody>;
export const AdminReasonBody = z.object({ reason: z.string().min(1).max(500) });
export type AdminReasonBody = z.infer<typeof AdminReasonBody>;
export const AdminReport = z.object({
  id: Uuid,
  subdomain: z.string(),
  subdomainExists: z.boolean(),
  category: ReportCategory,
  details: z.string(),
  contactEmail: z.email().nullable(),
  reporter: PublicUser.nullable(),
  status: ReportStatus,
  handledBy: PublicUser.nullable(),
  resolutionNote: z.string().nullable(),
  createdAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
});
export type AdminReport = z.infer<typeof AdminReport>;
export const AdminResolveReportBody = z.object({
  status: z.enum(["actioned", "dismissed"]),
  resolutionNote: z.string().max(1000),
  suspendSubdomain: z.boolean().default(false),
});
export type AdminResolveReportBody = z.infer<typeof AdminResolveReportBody>;
export const ReservedCategory = z.enum(["system", "brand", "offensive", "premium", "zone"]);
export type ReservedCategory = z.infer<typeof ReservedCategory>;
export const ReservedName = z.object({
  name: z.string(),
  category: ReservedCategory,
  note: z.string().nullable(),
  createdBy: PublicUser.nullable(),
  createdAt: IsoDateTime,
});
export type ReservedName = z.infer<typeof ReservedName>;
export const AddReservedBody = z.object({
  name: z.string().regex(/^[a-z0-9-]{1,63}$/),
  category: ReservedCategory,
  note: z.string().max(200).optional(),
});
export type AddReservedBody = z.infer<typeof AddReservedBody>;
export const AdminOverview = z.object({
  pendingReview: z.int(),
  openReports: z.int(),
  failedSyncs: z.int(),
  zone: Usage,
  users: z.int(),
  subdomains: z.int(),
});
export type AdminOverview = z.infer<typeof AdminOverview>;
export const DriftKind = z.enum(["missing", "modified", "orphan", "unmanaged"]);
export type DriftKind = z.infer<typeof DriftKind>;
export const ZoneReport = z.object({
  plan: z.string().nullable(),
  usage: Usage,
  systemRecords: z.int(),
  managedRecords: z.int(),
  drift: z.array(
    z.object({ kind: DriftKind, fqdn: z.string(), type: z.string(), detail: z.string() }),
  ),
  deadJobs: z.array(
    z.object({
      id: z.int(),
      kind: z.string(),
      lastError: z.string().nullable(),
      updatedAt: IsoDateTime,
    }),
  ),
  lastReconcileAt: IsoDateTime.nullable(),
});
export type ZoneReport = z.infer<typeof ZoneReport>;
export const AdminSettings = z.object({
  registrationOpen: z.boolean(),
  reviewMode: z.enum(["risk", "all", "none"]),
});
export type AdminSettings = z.infer<typeof AdminSettings>;
export const AuditQuery = PageQuery.extend({
  actorId: Uuid.optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  action: z.string().optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;
