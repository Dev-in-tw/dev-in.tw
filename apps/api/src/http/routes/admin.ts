import {
  adminAddReserved,
  adminGetSettings,
  adminListReserved,
  adminListSubdomains,
  adminListUsers,
  adminOverview,
  adminReconcile,
  adminRemoveReserved,
  adminRetrySyncJob,
  adminUpdateSettings,
  adminUpdateUser,
  adminZone,
} from "../../modules/admin/service.ts";
import { queryAudit } from "../../modules/audit/query.ts";
import { adminListReports, adminResolveReport } from "../../modules/moderation/reports.ts";
import {
  adminApproveSubdomain,
  adminRejectSubdomain,
  adminSuspendSubdomain,
  adminUnsuspendSubdomain,
} from "../../modules/moderation/suspension.ts";
import { define, type Registry } from "../define.ts";

export function adminRoutes(reg: Registry): void {
  define(reg, "adminOverview", ({ c }) => adminOverview(c.get("deps")));
  define(reg, "adminListUsers", ({ c, query }) => adminListUsers(c.get("deps"), query));
  define(reg, "adminUpdateUser", ({ c, params, body, actor }) =>
    adminUpdateUser(c.get("deps"), params.userId, body, actor),
  );
  define(reg, "adminListSubdomains", ({ c, query }) => adminListSubdomains(c.get("deps"), query));
  define(reg, "adminApproveSubdomain", ({ c, params, body, actor }) =>
    adminApproveSubdomain(c.get("deps"), params.name, body.reason, actor),
  );
  define(reg, "adminRejectSubdomain", ({ c, params, body, actor }) =>
    adminRejectSubdomain(c.get("deps"), params.name, body.reason, actor),
  );
  define(reg, "adminSuspendSubdomain", ({ c, params, body, actor }) =>
    adminSuspendSubdomain(c.get("deps"), params.name, body.reason, actor),
  );
  define(reg, "adminUnsuspendSubdomain", ({ c, params, body, actor }) =>
    adminUnsuspendSubdomain(c.get("deps"), params.name, body.reason, actor),
  );
  define(reg, "adminListReports", ({ c, query }) => adminListReports(c.get("deps"), query));
  define(reg, "adminResolveReport", ({ c, params, body, actor }) =>
    adminResolveReport(c.get("deps"), params.reportId, body, actor),
  );
  define(reg, "adminListReserved", ({ c, query }) => adminListReserved(c.get("deps"), query));
  define(reg, "adminAddReserved", ({ c, body, actor }) =>
    adminAddReserved(c.get("deps"), body, actor),
  );
  define(reg, "adminRemoveReserved", async ({ c, params, actor }) => {
    await adminRemoveReserved(c.get("deps"), params.name, actor);
    return new Response(null, { status: 204 });
  });
  define(reg, "adminAuditLog", ({ c, query }) =>
    queryAudit(
      c.get("deps").db,
      {
        actorId: query.actorId,
        targetType: query.targetType,
        targetId: query.targetId,
        action: query.action,
      },
      query,
    ),
  );
  define(reg, "adminZone", ({ c }) => adminZone(c.get("deps")));
  define(reg, "adminReconcile", async ({ c, query, actor }) => {
    await adminReconcile(c.get("deps"), query.force === "true", actor);
    return new Response(null, { status: 202 });
  });
  define(reg, "adminRetrySyncJob", async ({ c, params, actor }) => {
    await adminRetrySyncJob(c.get("deps"), params.jobId, actor);
    return new Response(null, { status: 204 });
  });
  define(reg, "adminGetSettings", ({ c }) => adminGetSettings(c.get("deps")));
  define(reg, "adminUpdateSettings", ({ c, body, actor }) =>
    adminUpdateSettings(c.get("deps"), body, actor),
  );
}
