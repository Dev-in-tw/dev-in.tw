import {
  bigint,
  bigserial,
  boolean,
  customType,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle 對應 db/migrations 的 schema（migration 是 DDL 的唯一來源，這裡只給查詢用的型別）。
 * 整合測試會對真的 PostgreSQL 跑過每個查詢，欄位不一致時會直接失敗。
 */

const citext = customType<{ data: string }>({ dataType: () => "citext" });
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const userRole = pgEnum("user_role", ["user", "admin"]);
export const userStatus = pgEnum("user_status", ["active", "suspended"]);
export const subdomainStatus = pgEnum("subdomain_status", [
  "pending_review",
  "active",
  "suspended",
  "releasing",
]);
export const recordType = pgEnum("record_type", ["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA"]);
export const syncStatus = pgEnum("sync_status", ["pending", "synced", "error", "deleting"]);
export const transferStatus = pgEnum("transfer_status", [
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "expired",
]);
export const reportStatus = pgEnum("report_status", ["open", "actioned", "dismissed"]);
export const reportCategory = pgEnum("report_category", [
  "phishing",
  "malware",
  "spam",
  "illegal",
  "impersonation",
  "other",
]);
export const reservedCategory = pgEnum("reserved_category", [
  "system",
  "brand",
  "offensive",
  "premium",
  "zone",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
  githubLogin: citext("github_login").notNull(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url").notNull(),
  email: citext("email"),
  githubCreatedAt: tz("github_created_at").notNull(),
  role: userRole("role").notNull().default("user"),
  status: userStatus("status").notNull().default("active"),
  suspendedReason: text("suspended_reason"),
  quotaSubdomains: integer("quota_subdomains"),
  quotaRecords: integer("quota_records"),
  deletionRequestedAt: tz("deletion_requested_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  lastLoginAt: tz("last_login_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  publicId: uuid("public_id").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: tz("created_at").notNull().defaultNow(),
  lastSeenAt: tz("last_seen_at").notNull().defaultNow(),
  idleExpiresAt: tz("idle_expires_at").notNull(),
  absoluteExpiresAt: tz("absolute_expires_at").notNull(),
  ip: inet("ip"),
  userAgent: text("user_agent"),
  revokedAt: tz("revoked_at"),
});

export const subdomains = pgTable("subdomains", {
  id: uuid("id").primaryKey(),
  name: citext("name").notNull().unique(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  status: subdomainStatus("status").notNull(),
  description: text("description").notNull().default(""),
  showInDirectory: boolean("show_in_directory").notNull().default(false),
  reviewReasons: text("review_reasons").array().notNull().default([]),
  suspendedReason: text("suspended_reason"),
  suspendedByUser: boolean("suspended_by_user").notNull().default(false),
  createdAt: tz("created_at").notNull().defaultNow(),
  activatedAt: tz("activated_at"),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export const dnsRecords = pgTable("dns_records", {
  id: uuid("id").primaryKey(),
  subdomainId: uuid("subdomain_id")
    .notNull()
    .references(() => subdomains.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: recordType("type").notNull(),
  ttl: integer("ttl").notNull(),
  data: jsonb("data").$type<Record<string, string | number>>().notNull(),
  version: integer("version").notNull().default(1),
  appliedVersion: integer("applied_version").notNull().default(0),
  providerRecordId: text("provider_record_id").unique(),
  providerType: recordType("provider_type"),
  syncStatus: syncStatus("sync_status").notNull().default("pending"),
  syncErrorCode: text("sync_error_code"),
  syncErrorMessage: text("sync_error_message"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export const dnsSyncJobs = pgTable("dns_sync_jobs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind")
    .$type<"upsert_record" | "delete_record" | "purge_subdomain" | "restore_subdomain">()
    .notNull(),
  recordId: uuid("record_id"),
  subdomainId: uuid("subdomain_id"),
  status: text("status")
    .$type<"queued" | "running" | "done" | "dead">()
    .notNull()
    .default("queued"),
  attempts: integer("attempts").notNull().default(0),
  runAt: tz("run_at").notNull().defaultNow(),
  lockedUntil: tz("locked_until"),
  lastError: text("last_error"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export const reservedNames = pgTable("reserved_names", {
  name: citext("name").primaryKey(),
  category: reservedCategory("category").notNull(),
  note: text("note"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const nameHolds = pgTable("name_holds", {
  name: citext("name").primaryKey(),
  previousOwnerId: uuid("previous_owner_id").references(() => users.id, { onDelete: "set null" }),
  reason: text("reason").notNull(),
  holdUntil: tz("hold_until").notNull(),
});

export const transfers = pgTable("transfers", {
  id: uuid("id").primaryKey(),
  subdomainId: uuid("subdomain_id")
    .notNull()
    .references(() => subdomains.id, { onDelete: "cascade" }),
  fromUserId: uuid("from_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  toUserId: uuid("to_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  status: transferStatus("status").notNull().default("pending"),
  keepRecords: boolean("keep_records").notNull().default(true),
  createdAt: tz("created_at").notNull().defaultNow(),
  expiresAt: tz("expires_at").notNull(),
  resolvedAt: tz("resolved_at"),
});

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey(),
  subdomainName: citext("subdomain_name").notNull(),
  subdomainId: uuid("subdomain_id").references(() => subdomains.id, { onDelete: "set null" }),
  category: reportCategory("category").notNull(),
  details: text("details").notNull(),
  contactEmail: citext("contact_email"),
  reporterUserId: uuid("reporter_user_id").references(() => users.id, { onDelete: "set null" }),
  reporterIpHash: text("reporter_ip_hash"),
  status: reportStatus("status").notNull().default("open"),
  handledBy: uuid("handled_by").references(() => users.id, { onDelete: "set null" }),
  resolutionNote: text("resolution_note"),
  createdAt: tz("created_at").notNull().defaultNow(),
  resolvedAt: tz("resolved_at"),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey(),
  actorType: text("actor_type").$type<"user" | "admin" | "system">().notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  targetLabel: text("target_label").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  ip: inet("ip"),
  requestId: text("request_id"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SubdomainRow = typeof subdomains.$inferSelect;
export type RecordRow = typeof dnsRecords.$inferSelect;
export type JobRow = typeof dnsSyncJobs.$inferSelect;
export type TransferRow = typeof transfers.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
export type AuditRow = typeof auditLogs.$inferSelect;
