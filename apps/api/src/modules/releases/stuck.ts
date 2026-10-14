import { sql } from "drizzle-orm";
import { type Deps, SYSTEM_ACTOR } from "../../context.ts";
import { DAY, HOUR } from "../../lib/clock.ts";
import { wakeWorker } from "../../sync/events-bus.ts";
import { enqueue } from "../../sync/queue.ts";
import { writeAudit } from "../audit/service.ts";

/**
 * 卡在 releasing 的子網域：purge 工作重試 8 次後變成 dead，或遇到永久錯誤直接結束，子網域就會一直停在
 * releasing；擁有者申請刪除帳號時，帳號列也因此永遠刪不掉（housekeeping 只刪沒有子網域的帳號）。
 *
 * housekeeping 每小時呼叫一次：找出沒有 queued／running purge 工作的 releasing 子網域，依失敗次數退避
 * （1、2、4、8、16 小時，最多 24 小時）重新排入 purge，並發 Discord 告警。告警只放子網域名稱與失敗次數，
 * 不放擁有者的 email 或 IP。
 */
export function stuckRequeueDelay(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(HOUR * 2 ** Math.min(failures - 1, 10), DAY);
}

type StuckRow = {
  id: string;
  name: string;
  owner_deleting: boolean;
  failures: string | number;
  last_failure: Date | string | null;
};

export async function requeueStuckReleases(deps: Deps): Promise<number> {
  const { db, clock, config, notifier } = deps;
  const now = clock.now();
  const rows = await db.execute<StuckRow>(sql`
    select s.id, s.name,
           (u.deletion_requested_at is not null) as owner_deleting,
           count(j.id) filter (
             where j.status = 'dead' or (j.status = 'done' and j.last_error is not null)
           ) as failures,
           max(j.updated_at) filter (
             where j.status = 'dead' or (j.status = 'done' and j.last_error is not null)
           ) as last_failure
      from subdomains s
      join users u on u.id = s.owner_id
      left join dns_sync_jobs j on j.kind = 'purge_subdomain' and j.subdomain_id = s.id
     where s.status = 'releasing'
       and not exists (
         select 1 from dns_sync_jobs a
          where a.kind = 'purge_subdomain' and a.subdomain_id = s.id
            and a.status in ('queued', 'running'))
     group by s.id, s.name, u.deletion_requested_at`);

  let requeued = 0;
  for (const row of rows) {
    const failures = Number(row.failures);
    const last = row.last_failure ? new Date(row.last_failure) : null;
    if (last && last.getTime() + stuckRequeueDelay(failures) > now.getTime()) continue;
    const fqdn = `${row.name}.${config.ROOT_DOMAIN}`;
    await db.transaction(async (tx) => {
      // 在交易裡再確認一次，避免和管理員的手動重新排入或 worker 重複
      const [busy] = await tx.execute(sql`
        select 1 from dns_sync_jobs
         where kind = 'purge_subdomain' and subdomain_id = ${row.id}
           and status in ('queued', 'running')
         limit 1`);
      if (busy) return;
      await enqueue(tx, { kind: "purge_subdomain", subdomainId: row.id, runAt: now });
      await writeAudit(tx, SYSTEM_ACTOR, {
        action: "subdomain.purge_requeued",
        targetType: "subdomain",
        targetId: row.id,
        targetLabel: fqdn,
        metadata: { failures, ownerDeleting: row.owner_deleting },
      });
      await wakeWorker(tx);
      requeued++;
    });
    if (failures > 0) {
      notifier.notify({
        key: `release-stuck:${row.id}`,
        title: "子網域釋出卡住，已重新排入清除",
        description: [
          `\`${fqdn}\` 的清除工作已失敗 ${failures} 次，已自動重新排入。`,
          row.owner_deleting ? "擁有者已申請刪除帳號：清除完成前，帳號資料無法刪除。" : null,
          `下一次仍失敗時，約 ${Math.round(stuckRequeueDelay(failures + 1) / HOUR)} 小時後再重試；也可以在 /admin/zone 手動重新排入。`,
        ]
          .filter(Boolean)
          .join("\n"),
        severity: failures >= 3 || row.owner_deleting ? "critical" : "warning",
        url: `${config.APP_ORIGIN}/admin/zone`,
      });
    }
  }
  return requeued;
}
