import { and, eq, ne, sql } from "drizzle-orm";
import { type Deps, SYSTEM_ACTOR } from "../context.ts";
import { ts } from "../db/client.ts";
import { dnsRecords, type JobRow, nameHolds, subdomains } from "../db/schema.ts";
import { addMs, DAY, MINUTE } from "../lib/clock.ts";
import { writeAudit } from "../modules/audit/service.ts";
import { setSetting } from "../modules/settings.ts";
import { asProviderError, type ProviderError } from "./errors.ts";
import { SYNC_CHANNEL } from "./events-bus.ts";
import { fqdnOf, toProviderInput } from "./mapper.ts";
import { ownershipComment, type ProviderRecord, parseOwnership } from "./provider-port.ts";
import {
  backoffDelay,
  claimJobs,
  completeJob,
  MAX_ATTEMPTS,
  markDead,
  rescheduleJob,
  sweepStaleJobs,
} from "./queue.ts";

const POLL_MS = 5000;
const AUTH_PAUSE_MS = 5 * MINUTE;
const DEFER_MS = 2000;
/** 等待同名紀錄刪除最多這麼久，之後照樣寫入（避免刪除卡住時永遠不建立） */
const MAX_DEFER_AGE_MS = 10 * MINUTE;
const CONFLICT_CODES = new Set([
  "cf:81053",
  "cf:81054",
  "cf:81055",
  "cf:81056",
  "cf:81057",
  "cf:81058",
  "mem:cname_conflict",
  "mem:duplicate",
]);

type Outcome = "done" | "retry" | "dead" | "deferred" | "paused" | "skipped";

/**
 * DNS sync worker（PLAN §3.8）：與 API 同一個 process，以 LISTEN dns_sync 喚醒並每 5 秒保底輪詢。
 * 一次只處理一批，依 run_at 順序逐一執行，所以同一個子網域的刪除一定先於後來的新增。
 */
export class SyncWorker {
  readonly #deps: Deps;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #again = false;
  #stopped = true;
  #unlisten: (() => Promise<void>) | null = null;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    const sub = await this.#deps.sql.listen(SYNC_CHANNEL, () => this.wake());
    this.#unlisten = () => sub.unlisten();
    this.#timer = setInterval(() => this.wake(), POLL_MS);
    this.#timer.unref();
    this.wake();
  }

  /** 停止接新工作，等待執行中的批次（最多 timeoutMs） */
  async stop(timeoutMs = 20_000): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#unlisten?.().catch(() => {});
    if (this.#running) {
      await Promise.race([this.#running, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
    }
  }

  wake(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = this.#loop().finally(() => {
      this.#running = null;
    });
  }

  async #loop(): Promise<void> {
    do {
      this.#again = false;
      try {
        const processed = await this.tick();
        if (processed > 0) this.#again = true;
      } catch (error) {
        this.#deps.logger.error({ err: error }, "sync worker tick failed");
      }
    } while (this.#again && !this.#stopped);
  }

  /** 處理一批到期的工作，回傳處理數量。測試直接呼叫。 */
  async tick(): Promise<number> {
    const { runtime, clock, db } = this.#deps;
    const now = clock.now();
    runtime.workerHeartbeat = now;
    if (runtime.workerPausedUntil && runtime.workerPausedUntil > now) return 0;
    runtime.workerPausedUntil = null;
    await sweepStaleJobs(db, now);
    const jobs = await claimJobs(db, now);
    const pausedUntil = (): Date | null => runtime.workerPausedUntil;
    for (const job of jobs) {
      const paused = pausedUntil();
      if (paused && paused > clock.now()) {
        await rescheduleJob(db, job, paused, "worker paused", false);
        continue;
      }
      await this.#run(job);
    }
    return jobs.length;
  }

  /** 測試用：一直處理到沒有到期的工作 */
  async drain(maxRounds = 50): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if ((await this.tick()) === 0) return;
    }
  }

  async #run(job: JobRow): Promise<void> {
    const started = performance.now();
    let outcome: Outcome = "done";
    let providerError: ProviderError | null = null;
    try {
      switch (job.kind) {
        case "upsert_record":
          outcome = await this.#upsert(job);
          break;
        case "delete_record":
          outcome = await this.#deleteRecord(job);
          break;
        case "purge_subdomain":
          outcome = await this.#purge(job);
          break;
        case "restore_subdomain":
          outcome = await this.#restore(job);
          break;
      }
    } catch (error) {
      providerError = asProviderError(error);
      if (!(error instanceof Error && error.name === "ProviderError")) {
        this.#deps.logger.error({ err: error, job_id: job.id }, "sync job crashed");
      }
      outcome = await this.#handleFailure(job, providerError);
    }
    this.#deps.logger.info(
      {
        evt: "sync_job",
        job_id: job.id,
        kind: job.kind,
        record_id: job.recordId,
        subdomain_id: job.subdomainId,
        attempt: job.attempts,
        outcome,
        provider_status: providerError?.httpStatus ?? null,
        provider_error_code: providerError?.providerCode ?? null,
        duration_ms: Math.round(performance.now() - started),
      },
      "sync job",
    );
  }

  async #loadRecord(id: string | null) {
    if (!id) return null;
    const [row] = await this.#deps.db
      .select({ record: dnsRecords, sub: subdomains })
      .from(dnsRecords)
      .innerJoin(subdomains, eq(subdomains.id, dnsRecords.subdomainId))
      .where(eq(dnsRecords.id, id))
      .limit(1);
    return row ?? null;
  }

  async #upsert(job: JobRow): Promise<Outcome> {
    const { db, provider, config, clock } = this.#deps;
    const loaded = await this.#loadRecord(job.recordId);
    if (!loaded || loaded.record.syncStatus === "deleting" || loaded.sub.status !== "active") {
      await completeJob(db, job.id, loaded ? "skipped" : "record gone");
      return "skipped";
    }
    const { record, sub } = loaded;

    // 同名還有刪除中的紀錄（例如改成 CNAME 前要先刪掉 A）：先等刪除完成
    const blocking = await db
      .select({ id: dnsRecords.id })
      .from(dnsRecords)
      .where(
        and(
          eq(dnsRecords.subdomainId, sub.id),
          eq(dnsRecords.name, record.name),
          eq(dnsRecords.syncStatus, "deleting"),
          ne(dnsRecords.id, record.id),
        ),
      )
      .limit(1);
    if (blocking.length > 0 && clock.now().getTime() - job.createdAt.getTime() < MAX_DEFER_AGE_MS) {
      await rescheduleJob(db, job, addMs(clock.now(), DEFER_MS), "waiting for deletes", false);
      return "deferred";
    }

    const version = record.version;
    const input = toProviderInput(record, sub.name, config.ROOT_DOMAIN);
    let result: ProviderRecord;
    if (!record.providerRecordId) {
      // 上次可能逾時但其實已建立：先用 comment 標記找，找到就接手
      const adopted = await provider.findByComment(ownershipComment(record.id));
      if (adopted && adopted.type === record.type) {
        result = await provider.replace(adopted.id, input);
      } else if (adopted) {
        const out = await provider.batch({ deletes: [adopted.id], replaces: [], creates: [input] });
        result = this.#first(out.created);
      } else {
        result = await provider.create(input);
      }
    } else if (record.providerType !== record.type) {
      // Cloudflare 已禁止就地改 type：用 batch 先刪後建
      const out = await provider.batch({
        deletes: [record.providerRecordId],
        replaces: [],
        creates: [input],
      });
      result = this.#first(out.created);
    } else {
      try {
        result = await provider.replace(record.providerRecordId, input);
      } catch (error) {
        if (asProviderError(error).kind !== "not_found") throw error;
        result = await provider.create(input); // provider 上被手動刪掉了
      }
    }

    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(dnsRecords)
        .set({
          providerRecordId: result.id,
          providerType: record.type,
          appliedVersion: version,
          syncStatus: sql`case when ${dnsRecords.version} = ${version} then 'synced'::sync_status else 'pending'::sync_status end`,
          syncErrorCode: null,
          syncErrorMessage: null,
          updatedAt: clock.now(),
        })
        .where(eq(dnsRecords.id, record.id))
        .returning();
      if (updated) {
        await this.#deps.bus.publish(tx, [sub.ownerId], {
          type: "record.sync",
          subdomain: sub.name,
          recordId: record.id,
          version: updated.version,
          syncStatus: updated.syncStatus,
          syncError: null,
        });
      }
      await completeJob(tx, job.id);
    });
    return "done";
  }

  #first(records: ProviderRecord[]): ProviderRecord {
    const [first] = records;
    if (!first) throw asProviderError(new Error("batch returned no created record"));
    return first;
  }

  async #deleteRecord(job: JobRow): Promise<Outcome> {
    const { db, provider } = this.#deps;
    const loaded = await this.#loadRecord(job.recordId);
    if (loaded?.record.syncStatus !== "deleting") {
      await completeJob(db, job.id, "skipped");
      return "skipped";
    }
    const { record, sub } = loaded;
    const providerId =
      record.providerRecordId ?? (await provider.findByComment(ownershipComment(record.id)))?.id;
    if (providerId) await provider.delete(providerId);
    await db.transaction(async (tx) => {
      await tx.delete(dnsRecords).where(eq(dnsRecords.id, record.id));
      await this.#deps.bus.publish(tx, [sub.ownerId], {
        type: "record.deleted",
        subdomain: sub.name,
        recordId: record.id,
      });
      await completeJob(tx, job.id);
    });
    return "done";
  }

  /** 刪掉子網域在 provider 上的所有紀錄（釋出或停權），再掃一次 scope 內有 dit: 標記的孤兒 */
  async #purge(job: JobRow): Promise<Outcome> {
    const { db, provider, config, clock } = this.#deps;
    if (!job.subdomainId) {
      await completeJob(db, job.id, "missing subdomain");
      return "skipped";
    }
    const [sub] = await db
      .select()
      .from(subdomains)
      .where(eq(subdomains.id, job.subdomainId))
      .limit(1);
    if (!sub) {
      await completeJob(db, job.id, "subdomain gone");
      return "skipped";
    }
    const records = await db.select().from(dnsRecords).where(eq(dnsRecords.subdomainId, sub.id));
    const ids = new Set(records.flatMap((r) => (r.providerRecordId ? [r.providerRecordId] : [])));
    const apex = `${sub.name}.${config.ROOT_DOMAIN}`;
    const system = new Set(
      config.SYSTEM_RECORD_NAMES.map((n) =>
        n === "@" ? config.ROOT_DOMAIN : `${n}.${config.ROOT_DOMAIN}`,
      ),
    );
    for await (const r of provider.listAll()) {
      const inScope = r.fqdn === apex || r.fqdn.endsWith(`.${apex}`);
      if (inScope && parseOwnership(r.comment) && !system.has(r.fqdn)) ids.add(r.id);
    }
    const all = [...ids];
    for (let i = 0; i < all.length; i += 100) {
      await provider.batch({ deletes: all.slice(i, i + 100), replaces: [], creates: [] });
    }

    const now = clock.now();
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(subdomains)
        .where(eq(subdomains.id, sub.id))
        .for("update");
      if (!current) return;
      if (current.status === "releasing") {
        await tx.delete(subdomains).where(eq(subdomains.id, sub.id));
        const holdUntil = addMs(now, config.NAME_COOLDOWN_DAYS * DAY);
        await tx
          .insert(nameHolds)
          .values({ name: sub.name, previousOwnerId: sub.ownerId, reason: "released", holdUntil })
          .onConflictDoUpdate({
            target: nameHolds.name,
            set: { previousOwnerId: sub.ownerId, reason: "released", holdUntil },
          });
        await writeAudit(tx, SYSTEM_ACTOR, {
          action: "subdomain.purged",
          targetType: "subdomain",
          targetId: sub.id,
          targetLabel: apex,
          metadata: { providerRecordsDeleted: all.length },
        });
      } else {
        // 停權（或在 purge 執行前已解除停權）：DB 保留紀錄，等 restore 時重新建立
        await tx
          .update(dnsRecords)
          .set({
            providerRecordId: null,
            providerType: null,
            appliedVersion: 0,
            syncStatus: sql`case when ${dnsRecords.syncStatus} = 'deleting' then 'deleting'::sync_status else 'pending'::sync_status end`,
            updatedAt: now,
          })
          .where(eq(dnsRecords.subdomainId, sub.id));
        // 已被刪除中的紀錄在 provider 上也清掉了，直接移除
        await tx
          .delete(dnsRecords)
          .where(and(eq(dnsRecords.subdomainId, sub.id), eq(dnsRecords.syncStatus, "deleting")));
        if (current.status === "active") await this.#enqueueAll(tx, sub.id, now);
      }
      await completeJob(tx, job.id);
    });
    return "done";
  }

  async #enqueueAll(
    tx: Parameters<Parameters<Deps["db"]["transaction"]>[0]>[0],
    subdomainId: string,
    now: Date,
  ) {
    await tx.execute(sql`
      insert into dns_sync_jobs (kind, record_id, subdomain_id, run_at)
      select 'upsert_record', id, subdomain_id, ${ts(now)} from dns_records
       where subdomain_id = ${subdomainId} and sync_status <> 'deleting'
      on conflict (record_id) where status = 'queued' and record_id is not null
      do update set run_at = least(dns_sync_jobs.run_at, excluded.run_at), updated_at = now()`);
  }

  async #restore(job: JobRow): Promise<Outcome> {
    const { db, clock } = this.#deps;
    if (!job.subdomainId) {
      await completeJob(db, job.id, "missing subdomain");
      return "skipped";
    }
    await db.transaction(async (tx) => {
      const [sub] = await tx
        .select()
        .from(subdomains)
        .where(eq(subdomains.id, job.subdomainId as string));
      if (sub?.status === "active") await this.#enqueueAll(tx, sub.id, clock.now());
      await completeJob(tx, job.id);
    });
    this.wake();
    return "done";
  }

  async #handleFailure(job: JobRow, error: ProviderError): Promise<Outcome> {
    const { db, clock, notifier, runtime, config } = this.#deps;
    const now = clock.now();
    const message = error.message;

    if (error.kind === "auth") {
      runtime.workerPausedUntil = addMs(now, AUTH_PAUSE_MS);
      runtime.providerAuthFailed = true;
      await rescheduleJob(db, job, runtime.workerPausedUntil, error.providerCode, false);
      notifier.notify({
        key: "provider-auth",
        title: "DNS provider 認證失敗",
        description: `worker 暫停 5 分鐘（${error.providerCode}）。請檢查 CLOUDFLARE_API_TOKEN 的權限與 IP filtering。`,
        severity: "critical",
      });
      return "paused";
    }

    const record = job.recordId ? await this.#loadRecord(job.recordId) : null;
    const markRecord = async (code: string, msg: string, terminal: "done" | "dead") => {
      await db.transaction(async (tx) => {
        if (record) {
          await tx
            .update(dnsRecords)
            .set({
              syncStatus: record.record.syncStatus === "deleting" ? "deleting" : "error",
              syncErrorCode: code,
              syncErrorMessage: msg,
              updatedAt: now,
            })
            .where(eq(dnsRecords.id, record.record.id));
          await this.#deps.bus.publish(tx, [record.sub.ownerId], {
            type: "record.sync",
            subdomain: record.sub.name,
            recordId: record.record.id,
            version: record.record.version,
            syncStatus: record.record.syncStatus === "deleting" ? "deleting" : "error",
            syncError: { code, message: msg },
          });
          await writeAudit(tx, SYSTEM_ACTOR, {
            action: "record.sync_failed",
            targetType: "subdomain",
            targetId: record.sub.id,
            targetLabel: `${record.sub.name}.${config.ROOT_DOMAIN}`,
            metadata: {
              recordId: record.record.id,
              fqdn: fqdnOf(record.record.name, record.sub.name, config.ROOT_DOMAIN),
              type: record.record.type,
              code,
              providerCode: error.providerCode,
            },
          });
        }
        if (terminal === "dead") await markDead(tx, job.id, `${error.providerCode}: ${msg}`);
        else await completeJob(tx, job.id, `${error.providerCode}: ${msg}`);
      });
    };

    if (error.kind === "capacity") {
      await markRecord("ZONE_CAPACITY_EXHAUSTED", "整個 zone 的紀錄數已達上限", "done");
      await setSetting(db, "registration_open", false);
      notifier.notify({
        key: "zone-capacity-exhausted",
        title: "Zone 紀錄數已達上限",
        description: "provider 回報 record quota exceeded，已自動關閉註冊。",
        severity: "critical",
      });
      return "done";
    }
    if (error.kind === "permanent") {
      const code = CONFLICT_CODES.has(error.providerCode)
        ? "RECORD_CONFLICT"
        : "UPSTREAM_DNS_ERROR";
      await markRecord(code, message, "done");
      return "done";
    }
    // transient / not_found（purge 等）：退避重試，超過次數就 dead
    if (job.attempts >= MAX_ATTEMPTS) {
      await markRecord("UPSTREAM_DNS_ERROR", "DNS 服務多次寫入失敗，請稍後按重試", "dead");
      notifier.notify({
        key: `dead-job:${job.id}`,
        title: "DNS 同步工作失敗（dead）",
        description: `job #${job.id} ${job.kind} 已重試 ${job.attempts} 次仍失敗：${error.providerCode}`,
        severity: "warning",
        url: `${config.APP_ORIGIN}/admin/zone`,
      });
      return "dead";
    }
    await rescheduleJob(
      db,
      job,
      addMs(now, backoffDelay(job.attempts)),
      `${error.providerCode}: ${message}`,
    );
    return "retry";
  }
}
