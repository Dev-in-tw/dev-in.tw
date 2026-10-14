import { RecordType } from "@dit/contract";
import { validateRecord } from "@dit/dns";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { systemFqdns } from "../config.ts";
import { type Deps, SYSTEM_ACTOR } from "../context.ts";
import { ts } from "../db/client.ts";
import {
  dnsRecords,
  type JobRow,
  nameHolds,
  type RecordRow,
  type SubdomainRow,
  subdomains,
} from "../db/schema.ts";
import { addMs, DAY, MINUTE } from "../lib/clock.ts";
import { writeAudit } from "../modules/audit/service.ts";
import { recordDto, recordInputOf } from "../modules/dto.ts";
import { setSetting } from "../modules/settings.ts";
import { type BatchPlan, type PlannedUpsert, planBatch } from "./batch.ts";
import { BATCH_MAX_WAIT_MS, BATCH_QUIET_MS, currentSchedule, etaFrom } from "./batching.ts";
import { asProviderError, type ProviderError } from "./errors.ts";
import { SYNC_CHANNEL } from "./events-bus.ts";
import { fqdnOf, toProviderInput } from "./mapper.ts";
import {
  claimOwnership,
  listProviderRecords,
  ownerIndex,
  ownershipZone,
  pruneOwnership,
} from "./ownership.ts";
import {
  ownershipComment,
  type ProviderRecord,
  parseOwnership,
  type RrsetWriter,
  type RrsetZone,
} from "./provider-port.ts";
import {
  backoffDelay,
  claimJobs,
  completeJob,
  dueSummary,
  enqueue,
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
  "lazco:DNS_CNAME_CONFLICT",
  "lazco:DNS_DUPLICATE_RECORD",
  "lazco:DNS_DUPLICATE_RRSET",
]);
/** 批次模式：一次最多取這麼多工作；鎖久一點，涵蓋 412／409 時的重新讀取與重送 */
const BATCH_MAX_JOBS = 500;
const BATCH_LOCK_MS = 5 * MINUTE;

type Tx = Parameters<Parameters<Deps["db"]["transaction"]>[0]>[0];
type Loaded = { record: RecordRow; sub: SubdomainRow };

type Outcome = "done" | "retry" | "dead" | "deferred" | "paused" | "skipped";

/** 清除中的子網域範圍內，有擁有者的值有幾個（稽核紀錄的 providerRecordsDeleted） */
function countOwnedInScope(
  zone: RrsetZone,
  writer: Pick<RrsetWriter, "idOf">,
  owners: ReadonlyMap<string, string>,
  apexes: readonly string[],
): number {
  let n = 0;
  for (const r of zone.rrsets) {
    if (!apexes.some((a) => r.fqdn === a || r.fqdn.endsWith(`.${a}`))) continue;
    for (const v of r.values) if (owners.has(writer.idOf(r.fqdn, r.type, v))) n++;
  }
  return n;
}

const conflictOf = (conflicts: ReadonlyMap<string, string>, id: string) => {
  const message = conflicts.get(id);
  return message ? { code: "RECORD_CONFLICT", message } : null;
};

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
    const writer = this.#deps.provider.rrsets;
    if (writer) return this.#tickBatched(writer);
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

  // ── 批次模式（provider.rrsets，Lazco DNS；PLAN §3.8.1） ─────────────────────────────────────

  /**
   * 批次模式的一輪：到期的工作累積到「最後一筆安靜 10 秒，或最早一筆等了 60 秒」，而且到了排程時間
   * （今天剩下的時間 ÷ 剩下的額度）才一次取出、合成一批 RRset 變更送出。還沒到時間就不取件，
   * 避免增加 attempts 與上鎖。
   */
  async #tickBatched(writer: RrsetWriter): Promise<number> {
    const { db, clock } = this.#deps;
    const now = clock.now();
    const due = await dueSummary(db, now);
    if (due.count === 0) return 0;
    const schedule = await currentSchedule(this.#deps, writer);
    if (!schedule || schedule.nextAt > now) return 0;
    const quiet = !due.newest || now.getTime() - due.newest.getTime() >= BATCH_QUIET_MS;
    const waited = !due.oldest || now.getTime() - due.oldest.getTime() >= BATCH_MAX_WAIT_MS;
    if (!quiet && !waited) return 0;

    let jobs = await claimJobs(db, now, BATCH_MAX_JOBS, BATCH_LOCK_MS);
    // restore 只是把紀錄重新排入，先做完再把它排入的工作一起取進這一批
    const restores = jobs.filter((j) => j.kind === "restore_subdomain");
    for (const job of restores) await this.#run(job);
    if (restores.length > 0) {
      jobs = jobs.filter((j) => j.kind !== "restore_subdomain");
      jobs.push(...(await claimJobs(db, clock.now(), BATCH_MAX_JOBS, BATCH_LOCK_MS)));
    }
    if (jobs.length > 0) await this.#runBatch(jobs, writer);
    return restores.length + jobs.length;
  }

  async #runBatch(jobs: JobRow[], writer: RrsetWriter): Promise<void> {
    const started = performance.now();
    const { db, config, clock } = this.#deps;
    const root = config.ROOT_DOMAIN;
    const zoneKey = ownershipZone(this.#deps);
    const skipped: { job: JobRow; note: string }[] = [];
    const upserts: (Loaded & { job: JobRow })[] = [];
    const deletes: (Loaded & { job: JobRow })[] = [];
    const purges: { job: JobRow; sub: SubdomainRow }[] = [];

    for (const job of jobs) {
      if (job.kind === "purge_subdomain") {
        const [sub] = job.subdomainId
          ? await db.select().from(subdomains).where(eq(subdomains.id, job.subdomainId)).limit(1)
          : [];
        if (sub) purges.push({ job, sub });
        else skipped.push({ job, note: "subdomain gone" });
        continue;
      }
      const loaded = await this.#loadRecord(job.recordId);
      if (job.kind === "delete_record") {
        if (loaded?.record.syncStatus === "deleting") deletes.push({ ...loaded, job });
        else skipped.push({ job, note: "skipped" });
        continue;
      }
      if (!loaded || loaded.record.syncStatus === "deleting" || loaded.sub.status !== "active") {
        skipped.push({ job, note: loaded ? "skipped" : "record gone" });
        continue;
      }
      upserts.push({ ...loaded, job });
    }

    // 同名還有刪除中、但不在這一批的紀錄（刪除在退避中）：先等它，和單筆模式相同
    const deleting = new Set(deletes.map((d) => d.record.id));
    const deferred: JobRow[] = [];
    const ready: typeof upserts = [];
    for (const u of upserts) {
      const blocking = await db
        .select({ id: dnsRecords.id })
        .from(dnsRecords)
        .where(
          and(
            eq(dnsRecords.subdomainId, u.sub.id),
            eq(dnsRecords.name, u.record.name),
            eq(dnsRecords.syncStatus, "deleting"),
            ne(dnsRecords.id, u.record.id),
          ),
        );
      const waiting = blocking.some((b) => !deleting.has(b.id));
      if (waiting && clock.now().getTime() - u.job.createdAt.getTime() < MAX_DEFER_AGE_MS) {
        deferred.push(u.job);
      } else ready.push(u);
    }

    // 送出前用 packages/dns 的規則（含 provider 的限制）再驗一次：一筆壞資料不能讓整批失敗
    const rejected = new Map<string, { code: string; message: string }>();
    const subIds = [...new Set(ready.map((u) => u.sub.id))];
    const siblings = subIds.length
      ? await db.select().from(dnsRecords).where(inArray(dnsRecords.subdomainId, subIds))
      : [];
    const ownerIds = [...new Set(ready.map((u) => u.sub.ownerId))];
    const owned = ownerIds.length
      ? await db
          .select({ ownerId: subdomains.ownerId, name: subdomains.name })
          .from(subdomains)
          .where(inArray(subdomains.ownerId, ownerIds))
      : [];
    for (const u of ready) {
      const verdict = validateRecord(recordInputOf(u.record), {
        sub: u.sub.name,
        root,
        existing: siblings
          .filter(
            (r) =>
              r.subdomainId === u.sub.id && r.id !== u.record.id && r.syncStatus !== "deleting",
          )
          .map((r) => recordDto(r, u.sub.name, root)),
        ownedSubdomains: owned.filter((o) => o.ownerId === u.sub.ownerId).map((o) => o.name),
        allowedTypes: RecordType.options,
        provider: config.DNS_PROVIDER,
      });
      if (!verdict.ok) {
        const first = verdict.violations[0];
        rejected.set(u.record.id, {
          code:
            first?.code === "RECORD_CONFLICT" || first?.code === "RECORD_DUPLICATE"
              ? "RECORD_CONFLICT"
              : "VALIDATION_FAILED",
          message: first?.message ?? "紀錄內容不符合目前 DNS 服務的規則",
        });
      }
    }

    // 規劃需要的索引：誰擁有哪個值、沒有在批次內的紀錄的 TTL
    const owners = await ownerIndex(this.#deps, writer);
    const live = await db
      .select({ id: dnsRecords.id, ttl: dnsRecords.ttl })
      .from(dnsRecords)
      .innerJoin(subdomains, eq(subdomains.id, dnsRecords.subdomainId))
      .where(and(ne(dnsRecords.syncStatus, "deleting"), eq(subdomains.status, "active")));
    const ttlOf = new Map(live.map((r) => [r.id, writer.normalizeTtl(r.ttl)]));
    // 一次 write() 內可能規劃好幾次（412 重新讀取、超過 100 個變更分批）：被判定衝突的紀錄在這次
    // write 內一直排除，不會因為後面某一次規劃沒碰到它而被當成已寫入
    const conflicts = new Map<string, string>();
    const planned = (): PlannedUpsert[] =>
      ready
        .filter((u) => !rejected.has(u.record.id) && !conflicts.has(u.record.id))
        .map((u) => {
          const input = toProviderInput(u.record, u.sub.name, root);
          return {
            recordId: u.record.id,
            fqdn: input.fqdn.toLowerCase(),
            type: input.type,
            value: writer.valueOf(input),
            ttl: writer.normalizeTtl(input.ttl),
          };
        });
    const protectedFqdns = new Set(systemFqdns(config));
    const purgeApexes = purges.map((p) => `${p.sub.name}.${root}`);

    // 寫入前記下所有權（intent）：PATCH 成功但回應遺失時，下一輪仍然認得這些值
    await claimOwnership(
      db,
      zoneKey,
      planned().map((u) => ({
        providerId: writer.idOf(u.fqdn, u.type, u.value),
        fqdn: u.fqdn,
        type: u.type.toUpperCase(),
        recordId: u.recordId,
      })),
    );

    const touched = new Set<string>();
    let includeUpserts = true;
    let purgedValues: number | null = null;
    const write = async () =>
      writer.write((zone) => {
        purgedValues ??= countOwnedInScope(zone, writer, owners, purgeApexes);
        const plan: BatchPlan = planBatch(zone, {
          writer,
          owners,
          upserts: includeUpserts ? planned() : [],
          deletes: deleting,
          purgeApexes,
          ttlOf,
          protectedFqdns,
        });
        for (const [id, reason] of plan.conflicts) conflicts.set(id, reason);
        for (const k of plan.touched) touched.add(k);
        return plan.changes;
      });

    let result: Awaited<ReturnType<RrsetWriter["write"]>> | null = null;
    let failure: ProviderError | null = null;
    let capacityHit: ProviderError | null = null;
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      try {
        result = await write();
      } catch (error) {
        const pe = asProviderError(error);
        // 整批被拒（422）：把問題對回批次內的紀錄，排除它們之後重送一次
        const keys = new Set(pe.issues.flatMap((i) => (i.key ? [i.key] : [])));
        const blamed = planned().filter((u) => keys.has(`${u.fqdn}|${u.type.toUpperCase()}`));
        if (pe.kind === "permanent" && blamed.length > 0 && attempt < 2) {
          for (const u of blamed) {
            const issue = pe.issues.find((i) => i.key === `${u.fqdn}|${u.type.toUpperCase()}`);
            rejected.set(u.recordId, {
              code: CONFLICT_CODES.has(`lazco:${issue?.code}`)
                ? "RECORD_CONFLICT"
                : "UPSTREAM_DNS_ERROR",
              message: pe.message,
            });
          }
          continue;
        }
        // zone 滿了：新增／修改走既有的容量處理（關閉註冊、通知），刪除與清除照常送出
        if (pe.kind === "capacity" && !pe.retryAt && includeUpserts && attempt < 2) {
          capacityHit = pe;
          includeUpserts = false;
          continue;
        }
        failure = pe;
        break;
      }
    }

    if (!result) {
      await this.#failBatch(jobs, writer, failure ?? asProviderError(null), deferred, skipped);
      this.#logBatch(jobs.length, 0, "failed", failure, started);
      return;
    }

    const finalZone = result.zone;
    const present = new Set(
      finalZone.rrsets.flatMap((r) => r.values.map((v) => writer.idOf(r.fqdn, r.type, v))),
    );
    for (const u of ready) {
      touched.add(`${fqdnOf(u.record.name, u.sub.name, root).toLowerCase()}|${u.record.type}`);
    }
    const now = clock.now();
    const eta = etaFrom(await currentSchedule(this.#deps, writer), now);
    await db.transaction(async (tx) => {
      await pruneOwnership(tx, zoneKey, touched, present);
      for (const d of deferred) {
        await rescheduleJob(tx, d, addMs(now, DEFER_MS), "waiting for deletes", false);
      }
      for (const { job, note } of skipped) await completeJob(tx, job.id, note);
      for (const u of ready) {
        const reason = rejected.get(u.record.id) ?? conflictOf(conflicts, u.record.id);
        if (reason) {
          await this.#markRecordError(tx, u, reason.code, reason.message, "batch:rejected");
          await completeJob(tx, u.job.id, `${reason.code}: ${reason.message}`);
          continue;
        }
        if (!includeUpserts) continue;
        const input = toProviderInput(u.record, u.sub.name, root);
        const providerId = writer.idOf(input.fqdn, input.type, writer.valueOf(input));
        await this.#markSynced(tx, u, providerId, eta);
        await completeJob(tx, u.job.id);
      }
      for (const d of deletes) {
        await tx.delete(dnsRecords).where(eq(dnsRecords.id, d.record.id));
        await this.#deps.bus.publish(tx, [d.sub.ownerId], {
          type: "record.deleted",
          subdomain: d.sub.name,
          recordId: d.record.id,
        });
        await completeJob(tx, d.job.id);
      }
      for (const p of purges) {
        await this.#finishPurge(tx, p.sub, purgedValues ?? 0, now);
        await completeJob(tx, p.job.id);
      }
    });
    if (capacityHit) {
      const blocked = ready.filter((u) => !rejected.has(u.record.id));
      for (const u of blocked) await this.#handleFailure(u.job, capacityHit);
    }
    this.#logBatch(jobs.length, result.patches, "done", capacityHit, started);
  }

  /** 寫入成功：記下 provider id、套用的版本；寫入期間又被改過就保持 pending 並重新排入 */
  async #markSynced(tx: Tx, loaded: Loaded, providerId: string, eta: string | null) {
    const { clock } = this.#deps;
    const { record, sub } = loaded;
    // 先刪後加回同一個值時，刪除中的那一筆可能還佔著同一個 provider id（unique）
    await tx
      .update(dnsRecords)
      .set({ providerRecordId: null })
      .where(and(eq(dnsRecords.providerRecordId, providerId), ne(dnsRecords.id, record.id)));
    const [updated] = await tx
      .update(dnsRecords)
      .set({
        providerRecordId: providerId,
        providerType: record.type,
        appliedVersion: record.version,
        syncStatus: sql`case when ${dnsRecords.version} = ${record.version} then 'synced'::sync_status else 'pending'::sync_status end`,
        syncErrorCode: null,
        syncErrorMessage: null,
        updatedAt: clock.now(),
      })
      .where(eq(dnsRecords.id, record.id))
      .returning();
    if (!updated) return;
    if (updated.syncStatus === "pending") {
      await enqueue(tx, {
        kind: "upsert_record",
        recordId: record.id,
        subdomainId: sub.id,
        runAt: clock.now(),
      });
    }
    await this.#deps.bus.publish(tx, [sub.ownerId], {
      type: "record.sync",
      subdomain: sub.name,
      recordId: record.id,
      version: updated.version,
      syncStatus: updated.syncStatus,
      syncError: null,
      ...(updated.syncStatus === "pending" ? { syncEta: eta } : {}),
    });
  }

  /** 整批失敗：每個工作依錯誤分類處理（退避、暫停或標記錯誤） */
  async #failBatch(
    jobs: JobRow[],
    writer: RrsetWriter,
    error: ProviderError,
    deferred: JobRow[],
    skipped: { job: JobRow; note: string }[],
  ): Promise<void> {
    const { db, clock, notifier, config } = this.#deps;
    const now = clock.now();
    for (const d of deferred) {
      await rescheduleJob(db, d, addMs(now, DEFER_MS), "waiting for deletes", false);
    }
    for (const { job, note } of skipped) await completeJob(db, job.id, note);
    if (error.retryAt && error.kind === "capacity") {
      // 每日批次上限：Lazco DNS 說已滿（例如有人在面板改過）時，讓本地的額度也停到下一個 UTC 日
      if (error.providerCode !== "budget:exhausted") await writer.budget.exhaust(now);
      notifier.notify({
        key: "dns-daily-batch-limit",
        title: "今日 DNS 變更批次額度已用完",
        description: `同步暫停到 ${error.retryAt.toISOString()}（${error.providerCode}）。使用者的變更會在下一個 UTC 日生效。`,
        severity: "warning",
        url: `${config.APP_ORIGIN}/admin/zone`,
      });
    }
    const handled = new Set([...deferred.map((d) => d.id), ...skipped.map((s) => s.job.id)]);
    for (const job of jobs) {
      if (!handled.has(job.id)) await this.#handleFailure(job, error);
    }
  }

  #logBatch(
    jobs: number,
    patches: number,
    outcome: "done" | "failed",
    error: ProviderError | null,
    started: number,
  ) {
    this.#deps.logger.info(
      {
        evt: "sync_batch",
        jobs,
        patches,
        outcome,
        provider_status: error?.httpStatus ?? null,
        provider_error_code: error?.providerCode ?? null,
        duration_ms: Math.round(performance.now() - started),
      },
      "sync batch",
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
      // 寫入 provider 的期間使用者又改了這筆紀錄：保持 pending 並重新排入，下一輪寫入最新版本
      if (updated?.syncStatus === "pending") {
        await enqueue(tx, {
          kind: "upsert_record",
          recordId: record.id,
          subdomainId: sub.id,
          runAt: clock.now(),
        });
      }
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
    const system = new Set(systemFqdns(config));
    for (const r of await listProviderRecords(this.#deps)) {
      const inScope = r.fqdn === apex || r.fqdn.endsWith(`.${apex}`);
      if (inScope && parseOwnership(r.comment) && !system.has(r.fqdn)) ids.add(r.id);
    }
    const all = [...ids];
    for (let i = 0; i < all.length; i += 100) {
      await provider.batch({ deletes: all.slice(i, i + 100), replaces: [], creates: [] });
    }
    await db.transaction(async (tx) => {
      await this.#finishPurge(tx, sub, all.length, clock.now());
      await completeJob(tx, job.id);
    });
    return "done";
  }

  /** provider 上的紀錄清掉之後：釋出就刪除子網域並保留名稱，停權就保留紀錄等 restore */
  async #finishPurge(tx: Tx, sub: SubdomainRow, deleted: number, now: Date): Promise<void> {
    const { config } = this.#deps;
    const apex = `${sub.name}.${config.ROOT_DOMAIN}`;
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
        metadata: { providerRecordsDeleted: deleted },
      });
      return;
    }
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

  async #enqueueAll(tx: Tx, subdomainId: string, now: Date) {
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

  /** 把紀錄標成同步失敗（刪除中的維持 deleting），推送給擁有者並寫稽核 */
  async #markRecordError(
    tx: Tx,
    loaded: Loaded,
    code: string,
    message: string,
    providerCode: string,
  ): Promise<void> {
    const { config, clock } = this.#deps;
    const status = loaded.record.syncStatus === "deleting" ? "deleting" : "error";
    await tx
      .update(dnsRecords)
      .set({
        syncStatus: status,
        syncErrorCode: code,
        syncErrorMessage: message,
        updatedAt: clock.now(),
      })
      .where(eq(dnsRecords.id, loaded.record.id));
    await this.#deps.bus.publish(tx, [loaded.sub.ownerId], {
      type: "record.sync",
      subdomain: loaded.sub.name,
      recordId: loaded.record.id,
      version: loaded.record.version,
      syncStatus: status,
      syncError: { code, message },
    });
    await writeAudit(tx, SYSTEM_ACTOR, {
      action: "record.sync_failed",
      targetType: "subdomain",
      targetId: loaded.sub.id,
      targetLabel: `${loaded.sub.name}.${config.ROOT_DOMAIN}`,
      metadata: {
        recordId: loaded.record.id,
        fqdn: fqdnOf(loaded.record.name, loaded.sub.name, config.ROOT_DOMAIN),
        type: loaded.record.type,
        code,
        providerCode,
      },
    });
  }

  async #handleFailure(job: JobRow, error: ProviderError): Promise<Outcome> {
    const { db, clock, notifier, runtime, config } = this.#deps;
    const now = clock.now();
    const message = error.message;

    if (error.kind === "auth") {
      runtime.workerPausedUntil = addMs(now, AUTH_PAUSE_MS);
      runtime.providerAuthFailed = true;
      await rescheduleJob(db, job, runtime.workerPausedUntil, error.providerCode, false);
      const hint =
        config.DNS_PROVIDER === "lazco"
          ? "請檢查 LAZCO_DNS_TOKEN 是否有效、範圍是否包含這個 zone，以及 zone 是否被 Lazco DNS 暫停。"
          : "請檢查 CLOUDFLARE_API_TOKEN 的權限與 IP filtering。";
      notifier.notify({
        key: "provider-auth",
        title: "DNS provider 認證失敗",
        description: `worker 暫停 5 分鐘（${error.providerCode}）。${hint}`,
        severity: "critical",
      });
      return "paused";
    }
    // provider 指定了重試時間（Lazco DNS 每日批次上限、限流）：延到那時候，不算重試次數、不標錯誤
    if (error.retryAt) {
      await rescheduleJob(db, job, error.retryAt, `${error.providerCode}: ${message}`, false);
      return "paused";
    }

    const record = job.recordId ? await this.#loadRecord(job.recordId) : null;
    const markRecord = async (code: string, msg: string, terminal: "done" | "dead") => {
      await db.transaction(async (tx) => {
        if (record) await this.#markRecordError(tx, record, code, msg, error.providerCode);
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
