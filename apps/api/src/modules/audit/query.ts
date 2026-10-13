import type { AuditEvent } from "@dit/contract";
import { and, desc, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { type AuditRow, auditLogs, users } from "../../db/schema.ts";
import { decodeCursor, iso, pageOf, publicUser } from "../dto.ts";

export interface AuditFilter {
  actorId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  action?: string | undefined;
  since?: Date | undefined;
}

/** 稽核紀錄分頁（新到舊，以 UUIDv7 id 當游標）。對外不輸出 IP。 */
export async function queryAudit(
  ex: Executor,
  filter: AuditFilter,
  page: { cursor?: string | undefined; limit: number },
): Promise<{ items: AuditEvent[]; nextCursor: string | null }> {
  const conditions: SQL[] = [];
  if (filter.actorId) conditions.push(eq(auditLogs.actorUserId, filter.actorId));
  if (filter.targetType) conditions.push(eq(auditLogs.targetType, filter.targetType));
  if (filter.targetId) conditions.push(eq(auditLogs.targetId, filter.targetId));
  if (filter.action) conditions.push(eq(auditLogs.action, filter.action));
  if (filter.since) conditions.push(gte(auditLogs.createdAt, filter.since));
  const cursor = decodeCursor(page.cursor);
  if (cursor) conditions.push(lt(auditLogs.id, cursor));
  const rows = await ex
    .select()
    .from(auditLogs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.id))
    .limit(page.limit + 1);
  const { items, nextCursor } = pageOf(rows, page.limit, (r) => r.id);
  return { items: await toAuditEvents(ex, items), nextCursor };
}

export async function toAuditEvents(ex: Executor, rows: AuditRow[]): Promise<AuditEvent[]> {
  const actorIds = [...new Set(rows.flatMap((r) => (r.actorUserId ? [r.actorUserId] : [])))];
  const actors = actorIds.length
    ? await ex.select().from(users).where(inArray(users.id, actorIds))
    : [];
  const byId = new Map(actors.map((u) => [u.id, u]));
  return rows.map((r) => {
    const actor = r.actorUserId ? byId.get(r.actorUserId) : undefined;
    return {
      id: r.id,
      action: r.action,
      actor: actor ? publicUser(actor) : null,
      actorType: r.actorType,
      target: { type: r.targetType, id: r.targetId, label: r.targetLabel },
      metadata: r.metadata,
      createdAt: iso(r.createdAt),
    };
  });
}
