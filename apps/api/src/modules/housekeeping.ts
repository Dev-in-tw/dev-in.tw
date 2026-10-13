import { and, isNotNull, lt, sql } from "drizzle-orm";
import type { Deps } from "../context.ts";
import { ts } from "../db/client.ts";
import { auditLogs, idempotencyKeys, nameHolds } from "../db/schema.ts";
import { DAY, HOUR } from "../lib/clock.ts";
import { expireTransfers } from "./transfers/service.ts";

const LOCK_KEY = "28548153004385636";

/**
 * 定期清理（PLAN §3.5 資料保存）：session 過期 7 天後刪除、idempotency key 24 小時、name hold 到期、
 * audit IP 90 天後清空、audit 保留 1 年、過期的轉移、已申請刪除且子網域都清掉的帳號。
 */
export async function runHousekeeping(deps: Deps): Promise<Record<string, number>> {
  const reserved = await deps.sql.reserve();
  try {
    const [lock] = await reserved<
      { ok: boolean }[]
    >`select pg_try_advisory_lock(${LOCK_KEY}::bigint) as ok`;
    if (!lock?.ok) return {};
    try {
      const now = deps.clock.now();
      const ago = (ms: number) => new Date(now.getTime() - ms);
      const sessions = await deps.db.execute(sql`
        delete from sessions
         where coalesce(revoked_at, least(idle_expires_at, absolute_expires_at)) < ${ts(ago(7 * DAY))}
            or least(idle_expires_at, absolute_expires_at) < ${ts(ago(7 * DAY))}
        returning id`);
      const idem = await deps.db
        .delete(idempotencyKeys)
        .where(lt(idempotencyKeys.createdAt, ago(DAY)))
        .returning({ k: idempotencyKeys.key });
      const holds = await deps.db
        .delete(nameHolds)
        .where(lt(nameHolds.holdUntil, now))
        .returning({ n: nameHolds.name });
      const ips = await deps.db
        .update(auditLogs)
        .set({ ip: null })
        .where(and(isNotNull(auditLogs.ip), lt(auditLogs.createdAt, ago(90 * DAY))))
        .returning({ id: auditLogs.id });
      const old = await deps.db
        .delete(auditLogs)
        .where(lt(auditLogs.createdAt, ago(365 * DAY)))
        .returning({ id: auditLogs.id });
      const jobs = await deps.db.execute(sql`
        delete from dns_sync_jobs where status = 'done' and updated_at < ${ts(ago(7 * DAY))} returning id`);
      const transfers = await expireTransfers(deps);
      const deleted = await deps.db.execute(sql`
        delete from users u
         where u.deletion_requested_at is not null
           and not exists (select 1 from subdomains s where s.owner_id = u.id)
        returning id`);
      const result = {
        sessions: sessions.length,
        idempotencyKeys: idem.length,
        nameHolds: holds.length,
        auditIpsCleared: ips.length,
        auditDeleted: old.length,
        jobsDeleted: jobs.length,
        transfersExpired: transfers,
        usersDeleted: deleted.length,
      };
      deps.logger.info({ evt: "housekeeping", ...result }, "housekeeping done");
      return result;
    } finally {
      await reserved`select pg_advisory_unlock(${LOCK_KEY}::bigint)`;
    }
  } finally {
    reserved.release();
  }
}

export const HOUSEKEEPING_INTERVAL_MS = HOUR;
