import type { Actor } from "../../context.ts";
import type { Executor } from "../../db/client.ts";
import { auditLogs } from "../../db/schema.ts";
import { uuidv7 } from "../../lib/ids.ts";

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  metadata?: Record<string, unknown>;
}

/** 稽核紀錄只新增不修改（PLAN §3.5）。和業務寫入放在同一個交易裡。 */
export async function writeAudit(ex: Executor, actor: Actor, entry: AuditEntry): Promise<void> {
  await ex.insert(auditLogs).values({
    id: uuidv7(),
    actorType: actor.type,
    actorUserId: actor.userId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    targetLabel: entry.targetLabel,
    metadata: entry.metadata ?? {},
    ip: actor.ip,
    requestId: actor.requestId,
  });
}
