import type { EndpointName, Endpoints } from "@dit/contract";

/**
 * 瀏覽器端用的路由表：只有 method 與 path，型別直接對到合約的 `endpoints`。
 *
 * 為什麼不直接用 `@dit/contract` 的 `createClient`：它在執行期需要整份 `endpoints`（含所有 zod
 * schema），會把 zod 打包進每一頁的 client bundle，Landing 的 160 KB 預算撐不住。這張表只做
 * `import type`，`satisfies` 讓任何與合約不一致的 method 或 path 在 typecheck 時就失敗。
 * Server 端（RSC）仍然使用合約的 `createClient`。
 */
type Route<N extends EndpointName> = readonly [Endpoints[N]["method"], Endpoints[N]["path"]];

export const routes = {
  getMeta: ["GET", "/meta"],
  getStats: ["GET", "/stats"],
  getStatus: ["GET", "/status"],
  listDirectory: ["GET", "/directory"],
  checkAvailability: ["GET", "/availability/{name}"],
  listPresets: ["GET", "/presets"],
  createReport: ["POST", "/reports"],
  startGithubLogin: ["GET", "/auth/github/start"],
  githubCallback: ["GET", "/auth/github/callback"],
  devLogin: ["POST", "/auth/dev-login"],
  logout: ["POST", "/auth/logout"],
  getMe: ["GET", "/me"],
  updateMe: ["PATCH", "/me"],
  deleteMe: ["DELETE", "/me"],
  listSessions: ["GET", "/me/sessions"],
  revokeSession: ["DELETE", "/me/sessions/{sessionId}"],
  revokeOtherSessions: ["POST", "/me/sessions/revoke-others"],
  acceptLegal: ["POST", "/me/consent"],
  exportMyData: ["GET", "/me/export"],
  listMyActivity: ["GET", "/me/activity"],
  events: ["GET", "/events"],
  listSubdomains: ["GET", "/subdomains"],
  createSubdomain: ["POST", "/subdomains"],
  getSubdomain: ["GET", "/subdomains/{name}"],
  updateSubdomain: ["PATCH", "/subdomains/{name}"],
  releaseSubdomain: ["POST", "/subdomains/{name}/release"],
  listSubdomainActivity: ["GET", "/subdomains/{name}/activity"],
  getPropagation: ["GET", "/subdomains/{name}/propagation"],
  listRecords: ["GET", "/subdomains/{name}/records"],
  createRecord: ["POST", "/subdomains/{name}/records"],
  replaceRecord: ["PUT", "/subdomains/{name}/records/{recordId}"],
  deleteRecord: ["DELETE", "/subdomains/{name}/records/{recordId}"],
  retryRecordSync: ["POST", "/subdomains/{name}/records/{recordId}/retry"],
  planPreset: ["POST", "/subdomains/{name}/presets/{presetId}/plan"],
  applyPreset: ["POST", "/subdomains/{name}/presets/{presetId}/apply"],
  createTransfer: ["POST", "/subdomains/{name}/transfer"],
  listTransfers: ["GET", "/transfers"],
  acceptTransfer: ["POST", "/transfers/{transferId}/accept"],
  declineTransfer: ["POST", "/transfers/{transferId}/decline"],
  cancelTransfer: ["POST", "/transfers/{transferId}/cancel"],
  adminOverview: ["GET", "/admin/overview"],
  adminListUsers: ["GET", "/admin/users"],
  adminUpdateUser: ["PATCH", "/admin/users/{userId}"],
  adminListSubdomains: ["GET", "/admin/subdomains"],
  adminApproveSubdomain: ["POST", "/admin/subdomains/{name}/approve"],
  adminRejectSubdomain: ["POST", "/admin/subdomains/{name}/reject"],
  adminSuspendSubdomain: ["POST", "/admin/subdomains/{name}/suspend"],
  adminUnsuspendSubdomain: ["POST", "/admin/subdomains/{name}/unsuspend"],
  adminListReports: ["GET", "/admin/reports"],
  adminResolveReport: ["PATCH", "/admin/reports/{reportId}"],
  adminListReserved: ["GET", "/admin/reserved-names"],
  adminAddReserved: ["POST", "/admin/reserved-names"],
  adminRemoveReserved: ["DELETE", "/admin/reserved-names/{name}"],
  adminAuditLog: ["GET", "/admin/audit-logs"],
  adminZone: ["GET", "/admin/zone"],
  adminReconcile: ["POST", "/admin/zone/reconcile"],
  adminRetrySyncJob: ["POST", "/admin/zone/jobs/{jobId}/retry"],
  adminGetSettings: ["GET", "/admin/settings"],
  adminUpdateSettings: ["PATCH", "/admin/settings"],
} as const satisfies { [N in EndpointName]: Route<N> };

/** 沒有 JSON body 的端點（204、redirect、SSE），與合約 `response: null` 一致 */
export const NO_BODY = new Set<EndpointName>([
  "startGithubLogin",
  "githubCallback",
  "devLogin",
  "logout",
  "deleteMe",
  "revokeSession",
  "revokeOtherSessions",
  "events",
  "adminRemoveReserved",
  "adminReconcile",
  "adminRetrySyncJob",
]);
