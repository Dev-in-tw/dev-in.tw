import { z } from "zod";
import {
  AddReservedBody,
  AdminDecisionBody,
  AdminOverview,
  AdminReasonBody,
  AdminReport,
  AdminResolveReportBody,
  AdminSettings,
  AdminSubdomain,
  AdminUpdateUserBody,
  AdminUser,
  AuditQuery,
  ReservedCategory,
  ReservedName,
  ZoneReport,
} from "./admin.ts";
import { DnsRecord, Propagation, PropagationQuery, RecordInput, RecordList } from "./dns.ts";
import type { ErrorCode } from "./errors.ts";
import { Availability } from "./naming.ts";
import { Preset, PresetBody, PresetId, PresetPlan } from "./preset.ts";
import { GithubLogin, PageQuery, page, SubdomainName, Uuid } from "./primitives.ts";
import { AuditEvent, DirectoryEntry, Meta, ServiceStatus, Stats } from "./public.ts";
import { CreateReportBody, ReportReceipt, ReportStatus } from "./report.ts";
import {
  CreateSubdomainBody,
  ReleaseSubdomainBody,
  Subdomain,
  SubdomainStatus,
  UpdateSubdomainBody,
} from "./subdomain.ts";
import { CreateTransferBody, Transfer, TransferList } from "./transfer.ts";
import { DeleteMeBody, Me, Role, Session, UpdateMeBody, UserStatus } from "./user.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type AuthLevel = "public" | "user" | "admin";

export interface Endpoint {
  method: HttpMethod;
  /** 相對於 /api/v1；路徑參數寫成 {name} */
  path: `/${string}`;
  auth: AuthLevel;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  headers?: readonly ("Idempotency-Key" | "If-Match")[];
  status: 200 | 201 | 202 | 204 | 302 | 303;
  /** null = 沒有 JSON body（204、redirect、SSE） */
  response: z.ZodType | null;
  errors: readonly ErrorCode[];
}

const NameParam = z.object({ name: SubdomainName });
const RecordParams = NameParam.extend({ recordId: Uuid });
const PresetParams = NameParam.extend({ presetId: PresetId });
const TransferParams = z.object({ transferId: Uuid });
const SessionParams = z.object({ sessionId: z.string() });
const UserParams = z.object({ userId: Uuid });
const ReportParams = z.object({ reportId: Uuid });
const ReservedParams = z.object({ name: z.string() });
const AvailabilityParams = z.object({ name: z.string().max(80) }); // 允許不合法的輸入，由回應的 status=invalid 說明原因

const OWNER_ERRORS = ["UNAUTHENTICATED", "NOT_FOUND", "ACCOUNT_SUSPENDED"] as const;
const WRITE_ERRORS = [
  ...OWNER_ERRORS,
  "CSRF_REJECTED",
  "RATE_LIMITED",
  "VALIDATION_FAILED",
] as const;

export const endpoints = {
  // 公開
  getMeta: {
    method: "GET",
    path: "/meta",
    auth: "public",
    status: 200,
    response: Meta,
    errors: [],
  },
  getStats: {
    method: "GET",
    path: "/stats",
    auth: "public",
    status: 200,
    response: Stats,
    errors: [],
  },
  getStatus: {
    method: "GET",
    path: "/status",
    auth: "public",
    status: 200,
    response: ServiceStatus,
    errors: [],
  },
  listDirectory: {
    method: "GET",
    path: "/directory",
    auth: "public",
    query: PageQuery,
    status: 200,
    response: page(DirectoryEntry),
    errors: [],
  },
  checkAvailability: {
    method: "GET",
    path: "/availability/{name}",
    auth: "public",
    params: AvailabilityParams,
    status: 200,
    response: Availability,
    errors: ["RATE_LIMITED"],
  },
  listPresets: {
    method: "GET",
    path: "/presets",
    auth: "public",
    status: 200,
    response: z.object({ items: z.array(Preset) }),
    errors: [],
  },
  createReport: {
    method: "POST",
    path: "/reports",
    auth: "public",
    body: CreateReportBody,
    status: 201,
    response: ReportReceipt,
    errors: ["VALIDATION_FAILED", "TURNSTILE_FAILED", "RATE_LIMITED", "CSRF_REJECTED"],
  },

  // 認證
  startGithubLogin: {
    method: "GET",
    path: "/auth/github/start",
    auth: "public",
    query: z.object({ redirect: z.string().max(200).optional() }),
    status: 302,
    response: null,
    errors: [],
  },
  githubCallback: {
    method: "GET",
    path: "/auth/github/callback",
    auth: "public",
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
    }),
    status: 303,
    response: null,
    errors: [],
  },
  devLogin: {
    method: "POST",
    path: "/auth/dev-login",
    auth: "public",
    body: z.object({
      githubLogin: GithubLogin,
      role: Role.default("user"),
      githubAgeDays: z.int().default(365),
    }),
    status: 204,
    response: null,
    errors: ["NOT_FOUND", "ACCOUNT_SUSPENDED"],
  },
  logout: {
    method: "POST",
    path: "/auth/logout",
    auth: "user",
    status: 204,
    response: null,
    errors: ["CSRF_REJECTED"],
  },

  // 我
  getMe: {
    method: "GET",
    path: "/me",
    auth: "user",
    status: 200,
    response: Me,
    errors: ["UNAUTHENTICATED"],
  },
  updateMe: {
    method: "PATCH",
    path: "/me",
    auth: "user",
    body: UpdateMeBody,
    status: 200,
    response: Me,
    errors: WRITE_ERRORS,
  },
  deleteMe: {
    method: "DELETE",
    path: "/me",
    auth: "user",
    body: DeleteMeBody,
    status: 202,
    response: null,
    errors: [...WRITE_ERRORS, "CONFIRMATION_MISMATCH"],
  },
  listSessions: {
    method: "GET",
    path: "/me/sessions",
    auth: "user",
    status: 200,
    response: z.object({ items: z.array(Session) }),
    errors: ["UNAUTHENTICATED"],
  },
  revokeSession: {
    method: "DELETE",
    path: "/me/sessions/{sessionId}",
    auth: "user",
    params: SessionParams,
    status: 204,
    response: null,
    errors: WRITE_ERRORS,
  },
  revokeOtherSessions: {
    method: "POST",
    path: "/me/sessions/revoke-others",
    auth: "user",
    status: 204,
    response: null,
    errors: WRITE_ERRORS,
  },
  listMyActivity: {
    method: "GET",
    path: "/me/activity",
    auth: "user",
    query: PageQuery,
    status: 200,
    response: page(AuditEvent),
    errors: ["UNAUTHENTICATED"],
  },
  events: {
    method: "GET",
    path: "/events",
    auth: "user",
    status: 200,
    response: null,
    errors: ["UNAUTHENTICATED", "RATE_LIMITED"],
  },

  // 子網域
  listSubdomains: {
    method: "GET",
    path: "/subdomains",
    auth: "user",
    status: 200,
    response: z.object({ items: z.array(Subdomain) }),
    errors: ["UNAUTHENTICATED"],
  },
  createSubdomain: {
    method: "POST",
    path: "/subdomains",
    auth: "user",
    body: CreateSubdomainBody,
    headers: ["Idempotency-Key"],
    status: 201,
    response: Subdomain,
    errors: [
      ...WRITE_ERRORS,
      "REGISTRATION_CLOSED",
      "TURNSTILE_FAILED",
      "NAME_INVALID",
      "NAME_RESERVED",
      "NAME_TAKEN",
      "NAME_COOLDOWN",
      "SUBDOMAIN_QUOTA_EXCEEDED",
      "ZONE_CAPACITY_EXHAUSTED",
      "IDEMPOTENCY_KEY_REUSED",
    ],
  },
  getSubdomain: {
    method: "GET",
    path: "/subdomains/{name}",
    auth: "user",
    params: NameParam,
    status: 200,
    response: Subdomain,
    errors: OWNER_ERRORS,
  },
  updateSubdomain: {
    method: "PATCH",
    path: "/subdomains/{name}",
    auth: "user",
    params: NameParam,
    body: UpdateSubdomainBody,
    status: 200,
    response: Subdomain,
    errors: WRITE_ERRORS,
  },
  releaseSubdomain: {
    method: "POST",
    path: "/subdomains/{name}/release",
    auth: "user",
    params: NameParam,
    body: ReleaseSubdomainBody,
    status: 202,
    response: Subdomain,
    errors: [...WRITE_ERRORS, "CONFIRMATION_MISMATCH", "SUBDOMAIN_NOT_ACTIVE"],
  },
  listSubdomainActivity: {
    method: "GET",
    path: "/subdomains/{name}/activity",
    auth: "user",
    params: NameParam,
    query: PageQuery,
    status: 200,
    response: page(AuditEvent),
    errors: OWNER_ERRORS,
  },
  getPropagation: {
    method: "GET",
    path: "/subdomains/{name}/propagation",
    auth: "user",
    params: NameParam,
    query: PropagationQuery,
    status: 200,
    response: Propagation,
    errors: [...OWNER_ERRORS, "RATE_LIMITED"],
  },

  // 紀錄
  listRecords: {
    method: "GET",
    path: "/subdomains/{name}/records",
    auth: "user",
    params: NameParam,
    status: 200,
    response: RecordList,
    errors: OWNER_ERRORS,
  },
  createRecord: {
    method: "POST",
    path: "/subdomains/{name}/records",
    auth: "user",
    params: NameParam,
    body: RecordInput,
    headers: ["Idempotency-Key"],
    status: 202,
    response: DnsRecord,
    errors: [
      ...WRITE_ERRORS,
      "SUBDOMAIN_NOT_ACTIVE",
      "RECORD_QUOTA_EXCEEDED",
      "ZONE_CAPACITY_EXHAUSTED",
      "RECORD_CONFLICT",
      "RECORD_DUPLICATE",
      "RECORD_TYPE_NOT_ALLOWED",
      "RECORD_TARGET_NOT_ALLOWED",
      "IP_NOT_PUBLIC",
      "IDEMPOTENCY_KEY_REUSED",
    ],
  },
  replaceRecord: {
    method: "PUT",
    path: "/subdomains/{name}/records/{recordId}",
    auth: "user",
    params: RecordParams,
    body: RecordInput,
    headers: ["If-Match"],
    status: 202,
    response: DnsRecord,
    errors: [
      ...WRITE_ERRORS,
      "SUBDOMAIN_NOT_ACTIVE",
      "VERSION_CONFLICT",
      "RECORD_CONFLICT",
      "RECORD_DUPLICATE",
      "RECORD_TYPE_NOT_ALLOWED",
      "RECORD_TARGET_NOT_ALLOWED",
      "IP_NOT_PUBLIC",
    ],
  },
  deleteRecord: {
    method: "DELETE",
    path: "/subdomains/{name}/records/{recordId}",
    auth: "user",
    params: RecordParams,
    headers: ["If-Match"],
    status: 202,
    response: DnsRecord,
    errors: [...WRITE_ERRORS, "VERSION_CONFLICT", "SUBDOMAIN_NOT_ACTIVE"],
  },
  retryRecordSync: {
    method: "POST",
    path: "/subdomains/{name}/records/{recordId}/retry",
    auth: "user",
    params: RecordParams,
    status: 202,
    response: DnsRecord,
    errors: [...WRITE_ERRORS, "SUBDOMAIN_NOT_ACTIVE"],
  },

  // Presets
  planPreset: {
    method: "POST",
    path: "/subdomains/{name}/presets/{presetId}/plan",
    auth: "user",
    params: PresetParams,
    body: PresetBody,
    status: 200,
    response: PresetPlan,
    errors: [...WRITE_ERRORS, "PRESET_PARAMS_INVALID"],
  },
  applyPreset: {
    method: "POST",
    path: "/subdomains/{name}/presets/{presetId}/apply",
    auth: "user",
    params: PresetParams,
    body: PresetBody,
    headers: ["Idempotency-Key"],
    status: 202,
    response: z.object({ created: z.array(DnsRecord), deletedIds: z.array(Uuid) }),
    errors: [
      ...WRITE_ERRORS,
      "PRESET_PARAMS_INVALID",
      "SUBDOMAIN_NOT_ACTIVE",
      "RECORD_QUOTA_EXCEEDED",
      "ZONE_CAPACITY_EXHAUSTED",
      "IDEMPOTENCY_KEY_REUSED",
    ],
  },

  // 轉移
  createTransfer: {
    method: "POST",
    path: "/subdomains/{name}/transfer",
    auth: "user",
    params: NameParam,
    body: CreateTransferBody,
    status: 201,
    response: Transfer,
    errors: [
      ...WRITE_ERRORS,
      "TRANSFER_RECIPIENT_NOT_FOUND",
      "TRANSFER_ALREADY_PENDING",
      "SUBDOMAIN_NOT_ACTIVE",
    ],
  },
  listTransfers: {
    method: "GET",
    path: "/transfers",
    auth: "user",
    status: 200,
    response: TransferList,
    errors: ["UNAUTHENTICATED"],
  },
  acceptTransfer: {
    method: "POST",
    path: "/transfers/{transferId}/accept",
    auth: "user",
    params: TransferParams,
    status: 200,
    response: Transfer,
    errors: [...WRITE_ERRORS, "TRANSFER_INVALID_STATE", "TRANSFER_RECIPIENT_QUOTA"],
  },
  declineTransfer: {
    method: "POST",
    path: "/transfers/{transferId}/decline",
    auth: "user",
    params: TransferParams,
    status: 200,
    response: Transfer,
    errors: [...WRITE_ERRORS, "TRANSFER_INVALID_STATE"],
  },
  cancelTransfer: {
    method: "POST",
    path: "/transfers/{transferId}/cancel",
    auth: "user",
    params: TransferParams,
    status: 200,
    response: Transfer,
    errors: [...WRITE_ERRORS, "TRANSFER_INVALID_STATE"],
  },

  // 管理
  adminOverview: {
    method: "GET",
    path: "/admin/overview",
    auth: "admin",
    status: 200,
    response: AdminOverview,
    errors: ["NOT_FOUND"],
  },
  adminListUsers: {
    method: "GET",
    path: "/admin/users",
    auth: "admin",
    query: PageQuery.extend({ q: z.string().max(64).optional(), status: UserStatus.optional() }),
    status: 200,
    response: page(AdminUser),
    errors: ["NOT_FOUND"],
  },
  adminUpdateUser: {
    method: "PATCH",
    path: "/admin/users/{userId}",
    auth: "admin",
    params: UserParams,
    body: AdminUpdateUserBody,
    status: 200,
    response: AdminUser,
    errors: WRITE_ERRORS,
  },
  adminListSubdomains: {
    method: "GET",
    path: "/admin/subdomains",
    auth: "admin",
    query: PageQuery.extend({
      q: z.string().max(64).optional(),
      status: SubdomainStatus.optional(),
    }),
    status: 200,
    response: page(AdminSubdomain),
    errors: ["NOT_FOUND"],
  },
  adminApproveSubdomain: {
    method: "POST",
    path: "/admin/subdomains/{name}/approve",
    auth: "admin",
    params: NameParam,
    body: AdminDecisionBody,
    status: 200,
    response: AdminSubdomain,
    errors: [...WRITE_ERRORS, "SUBDOMAIN_NOT_ACTIVE"],
  },
  adminRejectSubdomain: {
    method: "POST",
    path: "/admin/subdomains/{name}/reject",
    auth: "admin",
    params: NameParam,
    body: AdminReasonBody,
    status: 200,
    response: AdminSubdomain,
    errors: [...WRITE_ERRORS, "SUBDOMAIN_NOT_ACTIVE"],
  },
  adminSuspendSubdomain: {
    method: "POST",
    path: "/admin/subdomains/{name}/suspend",
    auth: "admin",
    params: NameParam,
    body: AdminReasonBody,
    status: 200,
    response: AdminSubdomain,
    errors: [...WRITE_ERRORS, "SUBDOMAIN_NOT_ACTIVE"],
  },
  adminUnsuspendSubdomain: {
    method: "POST",
    path: "/admin/subdomains/{name}/unsuspend",
    auth: "admin",
    params: NameParam,
    body: AdminDecisionBody,
    status: 200,
    response: AdminSubdomain,
    errors: [...WRITE_ERRORS, "SUBDOMAIN_NOT_ACTIVE"],
  },
  adminListReports: {
    method: "GET",
    path: "/admin/reports",
    auth: "admin",
    query: PageQuery.extend({ status: ReportStatus.optional() }),
    status: 200,
    response: page(AdminReport),
    errors: ["NOT_FOUND"],
  },
  adminResolveReport: {
    method: "PATCH",
    path: "/admin/reports/{reportId}",
    auth: "admin",
    params: ReportParams,
    body: AdminResolveReportBody,
    status: 200,
    response: AdminReport,
    errors: WRITE_ERRORS,
  },
  adminListReserved: {
    method: "GET",
    path: "/admin/reserved-names",
    auth: "admin",
    query: PageQuery.extend({
      q: z.string().max(64).optional(),
      category: ReservedCategory.optional(),
    }),
    status: 200,
    response: page(ReservedName),
    errors: ["NOT_FOUND"],
  },
  adminAddReserved: {
    method: "POST",
    path: "/admin/reserved-names",
    auth: "admin",
    body: AddReservedBody,
    status: 201,
    response: ReservedName,
    errors: WRITE_ERRORS,
  },
  adminRemoveReserved: {
    method: "DELETE",
    path: "/admin/reserved-names/{name}",
    auth: "admin",
    params: ReservedParams,
    status: 204,
    response: null,
    errors: WRITE_ERRORS,
  },
  adminAuditLog: {
    method: "GET",
    path: "/admin/audit-logs",
    auth: "admin",
    query: AuditQuery,
    status: 200,
    response: page(AuditEvent),
    errors: ["NOT_FOUND"],
  },
  adminZone: {
    method: "GET",
    path: "/admin/zone",
    auth: "admin",
    status: 200,
    response: ZoneReport,
    errors: ["NOT_FOUND"],
  },
  adminReconcile: {
    method: "POST",
    path: "/admin/zone/reconcile",
    auth: "admin",
    query: z.object({ force: z.enum(["true", "false"]).default("false") }), // force=true 才能越過大量刪除煞車
    status: 202,
    response: null,
    errors: WRITE_ERRORS,
  },
  adminGetSettings: {
    method: "GET",
    path: "/admin/settings",
    auth: "admin",
    status: 200,
    response: AdminSettings,
    errors: ["NOT_FOUND"],
  },
  adminUpdateSettings: {
    method: "PATCH",
    path: "/admin/settings",
    auth: "admin",
    body: AdminSettings.partial(),
    status: 200,
    response: AdminSettings,
    errors: WRITE_ERRORS,
  },
} as const satisfies Record<string, Endpoint>;

export type Endpoints = typeof endpoints;
export type EndpointName = keyof Endpoints;
