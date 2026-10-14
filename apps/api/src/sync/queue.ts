import { and, eq, sql } from "drizzle-orm";
import { type Executor, ts } from "../db/client.ts";
import { dnsSyncJobs, type JobRow } from "../db/schema.ts";

export type JobKind = JobRow["kind"];

/** 指數退避（PLAN §3.8）：5s、30s、2m、10m、30m、1h、2h、4h，最多 8 次 */
export const BACKOFF_MS = [5e3, 30e3, 120e3, 600e3, 1800e3, 3600e3, 7200e3, 14400e3] as const;
export const MAX_ATTEMPTS = BACKOFF_MS.length;
export const LOCK_MS = 60_000;

export function backoffDelay(attempts: number, random: () => number = Math.random): number {
  const base = BACKOFF_MS[Math.min(Math.max(attempts, 1), MAX_ATTEMPTS) - 1] ?? 5e3;
  return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * 排入工作。同一筆紀錄只會有一個 queued 的工作（coalesce index）；
 * 已經在退避中的工作被使用者再次修改時，提前到現在執行。
 */
export async function enqueue(
  ex: Executor,
  job: { kind: JobKind; recordId?: string | null; subdomainId?: string | null; runAt: Date },
): Promise<void> {
  await ex.execute(sql`
    insert into dns_sync_jobs (kind, record_id, subdomain_id, run_at)
    values (${job.kind}, ${job.recordId ?? null}, ${job.subdomainId ?? null}, ${ts(job.runAt)})
    on conflict (record_id) where status = 'queued' and record_id is not null
    do update set run_at = least(dns_sync_jobs.run_at, excluded.run_at), updated_at = now()`);
}

/** 刪除紀錄前先移除還沒執行的 upsert（否則 coalesce index 會擋掉 delete 工作） */
export async function cancelQueuedRecordJobs(ex: Executor, recordId: string): Promise<void> {
  await ex
    .delete(dnsSyncJobs)
    .where(and(eq(dnsSyncJobs.recordId, recordId), eq(dnsSyncJobs.status, "queued")));
}

/**
 * 以 SKIP LOCKED 取件，多個 worker 併發也不會拿到同一個工作；
 * 同一筆紀錄已經有 running 的工作時不取，避免同一筆紀錄被併發寫入 provider。
 */
export async function claimJobs(
  ex: Executor,
  now: Date,
  limit = 10,
  lockMs: number = LOCK_MS,
): Promise<JobRow[]> {
  const lockedUntil = new Date(now.getTime() + lockMs);
  const rows = await ex.execute<Record<string, unknown>>(sql`
    update dns_sync_jobs j
       set status = 'running', locked_until = ${ts(lockedUntil)}, attempts = attempts + 1, updated_at = now()
     where j.id in (
       select q.id from dns_sync_jobs q
        where q.status = 'queued' and q.run_at <= ${ts(now)}
          and not exists (
            select 1 from dns_sync_jobs r
             where r.status = 'running' and r.record_id is not null and r.record_id = q.record_id)
        order by q.run_at, q.id
        for update skip locked
        limit ${limit})
    returning j.id, j.kind, j.record_id, j.subdomain_id, j.status, j.attempts, j.run_at,
              j.locked_until, j.last_error, j.created_at, j.updated_at`);
  return rows
    .map((r) => ({
      id: Number(r.id),
      kind: r.kind as JobKind,
      recordId: (r.record_id as string | null) ?? null,
      subdomainId: (r.subdomain_id as string | null) ?? null,
      status: r.status as JobRow["status"],
      attempts: Number(r.attempts),
      runAt: new Date(r.run_at as string),
      lockedUntil: r.locked_until ? new Date(r.locked_until as string) : null,
      lastError: (r.last_error as string | null) ?? null,
      createdAt: new Date(r.created_at as string),
      updatedAt: new Date(r.updated_at as string),
    }))
    .sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.id - b.id);
}

export async function completeJob(ex: Executor, id: number, lastError: string | null = null) {
  await ex
    .update(dnsSyncJobs)
    .set({ status: "done", lockedUntil: null, lastError, updatedAt: sql`now()` })
    .where(eq(dnsSyncJobs.id, id));
}

export async function markDead(ex: Executor, id: number, lastError: string) {
  await ex
    .update(dnsSyncJobs)
    .set({ status: "dead", lockedUntil: null, lastError, updatedAt: sql`now()` })
    .where(eq(dnsSyncJobs.id, id));
}

/**
 * 放回佇列。countAttempt=false 時（worker 暫停、等待同名紀錄刪除）把這次取件的 attempts 退回。
 * 如果同一筆紀錄已經有新的 queued 工作，這個工作就直接結束（新的那個會處理最新狀態）。
 */
export async function rescheduleJob(
  ex: Executor,
  job: Pick<JobRow, "id" | "recordId">,
  runAt: Date,
  lastError: string | null,
  countAttempt = true,
): Promise<void> {
  await ex.execute(sql`
    update dns_sync_jobs j
       set status = case when exists (
             select 1 from dns_sync_jobs o
              where o.status = 'queued' and o.record_id is not null and o.record_id = j.record_id)
           then 'done' else 'queued' end,
           run_at = ${ts(runAt)}, locked_until = null, last_error = ${lastError},
           attempts = ${countAttempt ? sql`attempts` : sql`greatest(attempts - 1, 0)`},
           updated_at = now()
     where j.id = ${job.id}`);
}

/** 到期、等待執行的工作：數量、最新與最早的 run_at（批次模式決定何時送出） */
export async function dueSummary(
  ex: Executor,
  now: Date,
): Promise<{ count: number; newest: Date | null; oldest: Date | null }> {
  const [row] = await ex.execute<{
    n: string;
    newest: Date | string | null;
    oldest: Date | string | null;
  }>(sql`
    select count(*) as n, max(run_at) as newest, min(run_at) as oldest
      from dns_sync_jobs where status = 'queued' and run_at <= ${ts(now)}`);
  return {
    count: Number(row?.n ?? 0),
    newest: row?.newest ? new Date(row.newest) : null,
    oldest: row?.oldest ? new Date(row.oldest) : null,
  };
}

/** 執行中但鎖已過期（process 當掉）的工作放回佇列 */
export async function sweepStaleJobs(ex: Executor, now: Date): Promise<number> {
  const rows = await ex.execute(sql`
    update dns_sync_jobs j
       set status = case when exists (
             select 1 from dns_sync_jobs o
              where o.status = 'queued' and o.record_id is not null and o.record_id = j.record_id)
           then 'done' else 'queued' end,
           locked_until = null, run_at = ${ts(now)}, updated_at = now()
     where j.status = 'running' and j.locked_until < ${ts(now)}
    returning j.id`);
  return rows.length;
}

export interface QueueStats {
  pending: number;
  failed: number;
  oldestPendingSeconds: number | null;
}

export async function queueStats(ex: Executor, now: Date): Promise<QueueStats> {
  const [row] = await ex.execute<{
    pending: string;
    dead: string;
    oldest: Date | string | null;
  }>(sql`
    select count(*) filter (where status in ('queued','running')) as pending,
           count(*) filter (where status = 'dead') as dead,
           min(created_at) filter (where status in ('queued','running')) as oldest
      from dns_sync_jobs`);
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return {
    pending: Number(row?.pending ?? 0),
    failed: Number(row?.dead ?? 0),
    oldestPendingSeconds: oldest
      ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000))
      : null,
  };
}
