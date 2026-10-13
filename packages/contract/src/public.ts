import { z } from "zod";
import { RecordType } from "./dns.ts";
import { IsoDateTime, PublicUser, SubdomainName, Uuid } from "./primitives.ts";

export const Meta = z.object({
  rootDomain: z.string(),
  turnstileSiteKey: z.string(),
  registrationOpen: z.boolean(),
  limits: z.object({
    subdomainsPerUser: z.int(),
    recordsPerSubdomain: z.int(),
    nameMinLength: z.int(),
    nameMaxLength: z.int(),
  }),
  allowedRecordTypes: z.array(RecordType),
  zoneNearlyFull: z.boolean(), // 使用量 ≥ 90%，一般使用者只看得到這個布林值
  github: z.object({ org: z.url(), discord: z.url().nullable() }),
});
export type Meta = z.infer<typeof Meta>;
export const DirectoryEntry = z.object({
  name: SubdomainName,
  fqdn: z.string(),
  description: z.string(),
  owner: PublicUser,
  since: IsoDateTime,
});
export type DirectoryEntry = z.infer<typeof DirectoryEntry>;
export const Stats = z.object({
  subdomains: z.int(),
  members: z.int(),
  records: z.int(),
  latest: z.array(DirectoryEntry).max(10),
});
export type Stats = z.infer<typeof Stats>;
export const ComponentStatus = z.enum(["operational", "degraded", "down"]);
export type ComponentStatus = z.infer<typeof ComponentStatus>;
export const ServiceStatus = z.object({
  overall: ComponentStatus,
  components: z.array(
    z.object({
      id: z.enum(["api", "database", "dns_provider", "sync_worker"]),
      status: ComponentStatus,
      detail: z.string().nullable(),
    }),
  ),
  syncQueue: z.object({
    pending: z.int(),
    failed: z.int(),
    oldestPendingSeconds: z.int().nullable(),
  }),
  lastReconcileAt: IsoDateTime.nullable(),
  checkedAt: IsoDateTime,
});
export type ServiceStatus = z.infer<typeof ServiceStatus>;
export const AuditEvent = z.object({
  id: Uuid,
  action: z.string(),
  actor: PublicUser.nullable(), // null 代表系統
  actorType: z.enum(["user", "admin", "system"]),
  target: z.object({ type: z.string(), id: z.string(), label: z.string() }),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTime,
});
export type AuditEvent = z.infer<typeof AuditEvent>;
