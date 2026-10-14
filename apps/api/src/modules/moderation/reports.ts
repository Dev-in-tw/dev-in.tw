import type {
  AdminReport,
  AdminResolveReportBody,
  CreateReportBody,
  ReportStatus,
} from "@dit/contract";
import { and, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import type { Actor, Deps } from "../../context.ts";
import type { Executor } from "../../db/client.ts";
import { type ReportRow, reports, subdomains, users } from "../../db/schema.ts";
import { uuidv7 } from "../../lib/ids.ts";
import { hashIp } from "../../lib/net.ts";
import { AppError } from "../../lib/problem.ts";
import { writeAudit } from "../audit/service.ts";
import { decodeCursor, iso, isoOrNull, pageOf, publicUser } from "../dto.ts";
import { loadSubdomainByName, suspendSubdomainTx } from "./suspension.ts";

export async function createReport(
  deps: Deps,
  body: CreateReportBody,
  reporter: { userId: string | null },
  actor: Actor,
) {
  if (!(await deps.turnstile.verify(body.turnstileToken, actor.ip))) {
    throw new AppError("TURNSTILE_FAILED", "人機驗證失敗，請重新驗證");
  }
  const now = deps.clock.now();
  const name = body.subdomain.toLowerCase();
  const row = await deps.db.transaction(async (tx) => {
    const [sub] = await tx
      .select({ id: subdomains.id })
      .from(subdomains)
      .where(eq(subdomains.name, name))
      .limit(1);
    const [created] = await tx
      .insert(reports)
      .values({
        id: uuidv7(now.getTime()),
        subdomainName: name,
        subdomainId: sub?.id ?? null,
        category: body.category,
        details: body.details,
        contactEmail: body.contactEmail ?? null,
        reporterUserId: reporter.userId,
        reporterIpHash: hashIp(actor.ip, deps.config.REPORT_IP_SALT),
        createdAt: now,
      })
      .returning();
    if (!created) throw new Error("insert returned no row");
    // 檢舉人的 IP 只以加鹽雜湊保存（隱私權政策第 2 條），稽核紀錄不另外留原始 IP
    await writeAudit(
      tx,
      { ...actor, ip: null, type: reporter.userId ? "user" : "system" },
      {
        action: "report.create",
        targetType: "report",
        targetId: created.id,
        targetLabel: `${name}.${deps.config.ROOT_DOMAIN}`,
        metadata: { category: body.category },
      },
    );
    return created;
  });
  deps.notifier.notify({
    key: `report:${row.id}`,
    title: "新的檢舉",
    description: `\`${name}.${deps.config.ROOT_DOMAIN}\`（${body.category}）`,
    severity: "warning",
    url: `${deps.config.APP_ORIGIN}/admin/reports`,
  });
  return { id: row.id, createdAt: iso(row.createdAt) };
}

async function toAdminReports(ex: Executor, rows: ReportRow[]): Promise<AdminReport[]> {
  const userIds = [
    ...new Set(
      rows.flatMap((r) => [r.reporterUserId, r.handledBy].filter((x): x is string => !!x)),
    ),
  ];
  const people = userIds.length
    ? await ex.select().from(users).where(inArray(users.id, userIds))
    : [];
  const byId = new Map(people.map((u) => [u.id, u]));
  const names = [...new Set(rows.map((r) => r.subdomainName))];
  const existing = names.length
    ? new Set(
        (
          await ex
            .select({ n: subdomains.name })
            .from(subdomains)
            .where(inArray(subdomains.name, names))
        ).map((s) => s.n.toLowerCase()),
      )
    : new Set<string>();
  return rows.map((r) => {
    const reporter = r.reporterUserId ? byId.get(r.reporterUserId) : undefined;
    const handler = r.handledBy ? byId.get(r.handledBy) : undefined;
    return {
      id: r.id,
      subdomain: r.subdomainName,
      subdomainExists: existing.has(r.subdomainName.toLowerCase()),
      category: r.category,
      details: r.details,
      contactEmail: r.contactEmail,
      reporter: reporter ? publicUser(reporter) : null,
      status: r.status,
      handledBy: handler ? publicUser(handler) : null,
      resolutionNote: r.resolutionNote,
      createdAt: iso(r.createdAt),
      resolvedAt: isoOrNull(r.resolvedAt),
      redactedAt: isoOrNull(r.redactedAt),
    };
  });
}

export async function adminListReports(
  deps: Deps,
  query: { status?: ReportStatus | undefined; cursor?: string | undefined; limit: number },
) {
  const conditions: SQL[] = [];
  if (query.status) conditions.push(eq(reports.status, query.status));
  const cursor = decodeCursor(query.cursor);
  if (cursor) conditions.push(lt(reports.id, cursor));
  const rows = await deps.db
    .select()
    .from(reports)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(reports.id))
    .limit(query.limit + 1);
  const page = pageOf(rows, query.limit, (r) => r.id);
  return { items: await toAdminReports(deps.db, page.items), nextCursor: page.nextCursor };
}

export async function adminResolveReport(
  deps: Deps,
  reportId: string,
  body: AdminResolveReportBody,
  actor: Actor,
) {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(reports)
      .where(eq(reports.id, reportId))
      .for("update")
      .limit(1);
    if (!row) throw new AppError("NOT_FOUND", "找不到這筆檢舉");
    const now = deps.clock.now();
    if (body.suspendSubdomain) {
      const sub = await loadSubdomainByName(tx, row.subdomainName, true).catch(() => null);
      if (sub && sub.status !== "suspended" && sub.status !== "releasing") {
        await suspendSubdomainTx(
          tx,
          deps,
          sub,
          body.resolutionNote || `檢舉成立（${row.category}）`,
          actor,
        );
      }
    }
    const [updated] = await tx
      .update(reports)
      .set({
        status: body.status,
        resolutionNote: body.resolutionNote,
        handledBy: actor.userId,
        resolvedAt: now,
      })
      .where(eq(reports.id, row.id))
      .returning();
    if (!updated) throw new AppError("NOT_FOUND");
    await writeAudit(tx, actor, {
      action: "report.resolve",
      targetType: "report",
      targetId: row.id,
      targetLabel: `${row.subdomainName}.${deps.config.ROOT_DOMAIN}`,
      metadata: { status: body.status, suspendSubdomain: body.suspendSubdomain },
    });
    const [dto] = await toAdminReports(tx, [updated]);
    if (!dto) throw new Error("unreachable");
    return dto;
  });
}
