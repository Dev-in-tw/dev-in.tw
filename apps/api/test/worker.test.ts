import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryDnsProvider } from "../src/adapters/memory-dns/provider.ts";
import { ProviderError } from "../src/sync/errors.ts";
import type { ProviderRecord, ProviderRecordInput } from "../src/sync/provider-port.ts";
import { BACKOFF_MS, backoffDelay, claimJobs, enqueue, MAX_ATTEMPTS } from "../src/sync/queue.ts";
import { SyncWorker } from "../src/sync/worker.ts";
import { claim, login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

const transient = () => new ProviderError("transient", "http:503", "DNS 服務暫時無法使用");

describe("backoff schedule", () => {
  it("follows 5s, 30s, 2m, 10m, 30m, 1h, 2h, 4h with ±20% jitter", () => {
    expect(BACKOFF_MS).toEqual([5e3, 30e3, 120e3, 600e3, 1800e3, 3600e3, 7200e3, 14400e3]);
    expect(MAX_ATTEMPTS).toBe(8);
    expect(backoffDelay(1, () => 0)).toBe(4000);
    expect(backoffDelay(1, () => 1)).toBe(6000);
    expect(backoffDelay(8, () => 0.5)).toBe(14400e3);
    expect(backoffDelay(99, () => 0.5)).toBe(14400e3);
  });
});

describe.skipIf(!pgAvailable)("sync worker (real PostgreSQL)", () => {
  let t: TestContext;
  let cookie: string;
  let n = 0;

  const record = async (sub: string, body: Record<string, unknown>) => {
    t.clock.advance(7_000); // 每分鐘 10 次的寫入限流
    const res = await request(t, "POST", `/api/v1/subdomains/${sub}/records`, { cookie, body });
    expect(res.status, await res.clone().text()).toBe(202);
    return (await res.json()) as { id: string; version: number };
  };
  const row = async (id: string) => {
    const [r] = await t.deps.sql`select * from dns_records where id = ${id}`;
    return r as Record<string, unknown> | undefined;
  };
  const jobsFor = (id: string) =>
    t.deps.sql`select * from dns_sync_jobs where record_id = ${id} order by id`;
  const freshSub = async () => {
    n++;
    const name = `wk-${n}`;
    await claim(t, cookie, name);
    return name;
  };

  beforeAll(async () => {
    t = await setupTestApp();
    cookie = await login(t, "worker-owner");
    await t.deps
      .sql`update users set quota_subdomains = 100, quota_records = 100 where github_login = 'worker-owner'`;
  });
  beforeEach(() => {
    t.clock.advance(86_400_000); // 每天 5 次的申請限流
  });
  afterAll(() => t.close());

  it("claims jobs with SKIP LOCKED so concurrent workers never get the same job", async () => {
    const now = t.clock.now();
    await t.deps.db.transaction(async (tx) => {
      for (let i = 0; i < 40; i++) {
        await enqueue(tx, {
          kind: "restore_subdomain",
          subdomainId: "0199e2a1-7c00-7a00-8000-00000000ffff",
          runAt: now,
        });
      }
    });
    const batches = await Promise.all(
      Array.from({ length: 6 }, () => claimJobs(t.deps.db, now, 10)),
    );
    const ids = batches.flat().map((j) => j.id);
    expect(ids.length).toBe(40);
    expect(new Set(ids).size).toBe(40);
    await t.deps.sql`delete from dns_sync_jobs where kind = 'restore_subdomain'`;
  });

  it("does not claim a second job for a record that already has a running job", async () => {
    const sub = await freshSub();
    const r = await record(sub, { type: "TXT", name: "run", ttl: 1, value: "a" });
    await t.deps
      .sql`update dns_sync_jobs set status = 'running', locked_until = ${new Date(t.clock.now().getTime() + 60_000).toISOString()} where record_id = ${r.id}`;
    await t.deps
      .sql`insert into dns_sync_jobs (kind, record_id, subdomain_id, run_at) values ('upsert_record', ${r.id}, null, ${t.clock.now().toISOString()})`;
    const claimed = await claimJobs(t.deps.db, t.clock.now());
    expect(claimed.filter((j) => j.recordId === r.id)).toHaveLength(0);
    // 鎖過期後 sweeper 會把 running 的那個結束（已有新的 queued），queued 的照常處理
    t.clock.advance(61_000);
    await t.worker.drain();
    expect((await row(r.id))?.sync_status).toBe("synced");
  });

  it("retries transient failures with backoff and then succeeds", async () => {
    const sub = await freshSub();
    const r = await record(sub, { type: "A", name: "@", ttl: 1, address: "1.1.1.1" });
    t.provider.failNext("create", transient());
    await t.worker.tick();
    const [job] = await jobsFor(r.id);
    expect(job).toMatchObject({ status: "queued", attempts: 1 });
    const delay = new Date(job?.run_at as string).getTime() - t.clock.now().getTime();
    expect(delay).toBeGreaterThanOrEqual(4000);
    expect(delay).toBeLessThanOrEqual(6000);
    expect((await row(r.id))?.sync_status).toBe("pending");
    expect(await t.worker.tick()).toBe(0); // 還沒到期
    t.clock.advance(6_000);
    await t.worker.drain();
    expect((await row(r.id))?.sync_status).toBe("synced");
  });

  it("marks the job dead after 8 transient failures, flags the record and alerts", async () => {
    const sub = await freshSub();
    const r = await record(sub, { type: "A", name: "dead", ttl: 1, address: "1.1.1.2" });
    t.provider.failNext("create", transient(), MAX_ATTEMPTS);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await t.worker.tick();
      t.clock.advance(5 * 3600_000);
    }
    const [job] = await jobsFor(r.id);
    expect(job).toMatchObject({ status: "dead", attempts: MAX_ATTEMPTS });
    expect(await row(r.id)).toMatchObject({
      sync_status: "error",
      sync_error_code: "UPSTREAM_DNS_ERROR",
    });
    expect(t.notifier.sent.some((a) => a.key === `dead-job:${job?.id}`)).toBe(true);
    const audit = await t.deps
      .sql`select action from audit_logs where action = 'record.sync_failed' and metadata->>'recordId' = ${r.id}`;
    expect(audit).toHaveLength(1);
    // 使用者按重試會重新排入
    t.clock.advance(7_000);
    const retry = await request(t, "POST", `/api/v1/subdomains/${sub}/records/${r.id}/retry`, {
      cookie,
    });
    expect(retry.status).toBe(202);
    await t.worker.drain();
    expect((await row(r.id))?.sync_status).toBe("synced");
  });

  it("adopts a record that was created even though the provider call timed out", async () => {
    const sub = await freshSub();
    const r = await record(sub, { type: "TXT", name: "adopt", ttl: 1, value: "x" });
    t.provider.timeoutAfterCreate(1);
    await t.worker.tick();
    expect((await row(r.id))?.provider_record_id).toBeNull();
    t.clock.advance(6_000);
    await t.worker.drain();
    const matches = [...t.provider.records.values()].filter((p) => p.comment === `dit:${r.id}`);
    expect(matches).toHaveLength(1);
    expect((await row(r.id))?.provider_record_id).toBe(matches[0]?.id);
    expect((await row(r.id))?.sync_status).toBe("synced");
  });

  it("changes the type through a batch delete-then-create (Cloudflare forbids in-place type changes)", async () => {
    const sub = await freshSub();
    const r = await record(sub, { type: "A", name: "www", ttl: 1, address: "1.1.1.3" });
    await t.worker.drain();
    const before = (await row(r.id))?.provider_record_id;
    t.provider.calls.length = 0;
    t.clock.advance(7_000);
    const res = await request(t, "PUT", `/api/v1/subdomains/${sub}/records/${r.id}`, {
      cookie,
      body: { type: "CNAME", name: "www", ttl: 1, target: "alice.github.io" },
    });
    expect(res.status).toBe(202);
    await t.worker.drain();
    expect(t.provider.calls.map((c) => c.op)).toContain("batch");
    expect(t.provider.calls.map((c) => c.op)).not.toContain("replace");
    const after = await row(r.id);
    expect(after).toMatchObject({ sync_status: "synced", provider_type: "CNAME" });
    expect(after?.provider_record_id).not.toBe(before);
    const atProvider = [...t.provider.records.values()].filter(
      (p) => p.fqdn === `www.${sub}.dev-in.tw`,
    );
    expect(atProvider.map((p) => p.type)).toEqual(["CNAME"]);
  });

  it("keeps the record pending and resyncs when it changes while the provider call is in flight", async () => {
    const sub = await freshSub();
    const r = await record(sub, { type: "TXT", name: "race", ttl: 1, value: "v1" });
    class RacingProvider extends MemoryDnsProvider {
      raced = false;
      override async create(input: ProviderRecordInput): Promise<ProviderRecord> {
        if (!this.raced) {
          this.raced = true;
          await t.deps.db.execute(
            sql`update dns_records set version = version + 1, data = '{"value":"v2"}' where id = ${r.id}`,
          );
        }
        return super.create(input);
      }
    }
    const racing = new RacingProvider({ zoneName: "dev-in.tw" });
    const worker = new SyncWorker({ ...t.deps, provider: racing });
    await worker.tick();
    const mid = await row(r.id);
    expect(mid).toMatchObject({ sync_status: "pending", applied_version: 1, version: 2 });
    await worker.drain();
    const done = await row(r.id);
    expect(done).toMatchObject({ sync_status: "synced", applied_version: 2 });
    const stored = [...racing.records.values()].find((p) => p.comment === `dit:${r.id}`);
    expect(stored?.content).toBe('"v2"');
  });

  it("marks permanent errors without retrying", async () => {
    const sub = await freshSub();
    const r = await record(sub, { type: "TXT", name: "perm", ttl: 1, value: "x" });
    t.provider.failNext(
      "create",
      new ProviderError("permanent", "cf:81053", "同名已有紀錄，與 CNAME 衝突", 400),
    );
    await t.worker.tick();
    expect(await row(r.id)).toMatchObject({
      sync_status: "error",
      sync_error_code: "RECORD_CONFLICT",
    });
    const [job] = await jobsFor(r.id);
    expect(job?.status).toBe("done");
  });

  it("pauses the whole worker for 5 minutes on authentication errors", async () => {
    const sub = await freshSub();
    const r = await record(sub, { type: "TXT", name: "auth", ttl: 1, value: "x" });
    t.provider.failNext("create", new ProviderError("auth", "http:401", "DNS 服務認證失敗", 401));
    await t.worker.tick();
    expect(t.deps.runtime.workerPausedUntil).not.toBeNull();
    expect(
      t.notifier.sent.some((a) => a.key === "provider-auth" && a.severity === "critical"),
    ).toBe(true);
    const [job] = await jobsFor(r.id);
    expect(job).toMatchObject({ status: "queued", attempts: 0 });
    const status = (await (await request(t, "GET", "/api/v1/status")).json()) as {
      components: { id: string; status: string }[];
    };
    expect(status.components.find((c) => c.id === "dns_provider")?.status).toBe("degraded");
    t.clock.advance(60_000);
    expect(await t.worker.tick()).toBe(0);
    t.clock.advance(5 * 60_000);
    await t.worker.drain();
    expect((await row(r.id))?.sync_status).toBe("synced");
    t.deps.runtime.providerAuthFailed = false;
  });

  it("closes registration when the provider reports the zone is full", async () => {
    const sub = await freshSub();
    const r = await record(sub, { type: "TXT", name: "cap", ttl: 1, value: "x" });
    t.provider.failNext(
      "create",
      new ProviderError("capacity", "cf:81045", "zone 紀錄數已達上限", 400),
    );
    await t.worker.tick();
    expect(await row(r.id)).toMatchObject({
      sync_status: "error",
      sync_error_code: "ZONE_CAPACITY_EXHAUSTED",
    });
    const meta = (await (await request(t, "GET", "/api/v1/meta")).json()) as {
      registrationOpen: boolean;
    };
    expect(meta.registrationOpen).toBe(false);
    expect(t.notifier.sent.some((a) => a.key === "zone-capacity-exhausted")).toBe(true);
    await t.deps.sql`delete from settings where key = 'registration_open'`;
  });

  it("deletes records at the provider before removing them from the database", async () => {
    const sub = await freshSub();
    const r = await record(sub, { type: "TXT", name: "gone", ttl: 1, value: "x" });
    await t.worker.drain();
    t.clock.advance(7_000);
    await request(t, "DELETE", `/api/v1/subdomains/${sub}/records/${r.id}`, { cookie });
    t.provider.failNext("delete", transient());
    await t.worker.tick();
    expect((await row(r.id))?.sync_status).toBe("deleting");
    t.clock.advance(6_000);
    await t.worker.drain();
    expect(await row(r.id)).toBeUndefined();
    expect([...t.provider.records.values()].some((p) => p.comment === `dit:${r.id}`)).toBe(false);
  });

  it("purges on suspension (DB kept) and restores on unsuspension", async () => {
    const admin = await login(t, "worker-admin", { role: "admin" });
    const sub = await freshSub();
    const a = await record(sub, { type: "A", name: "@", ttl: 1, address: "1.1.1.4" });
    await record(sub, { type: "TXT", name: "_x", ttl: 1, value: "y" });
    await t.worker.drain();
    // 範圍內但 DB 沒有的 dit: 孤兒也會被清掉；範圍外的紀錄不受影響
    t.provider.seed({
      fqdn: `orphan.${sub}.dev-in.tw`,
      type: "TXT",
      ttl: 1,
      content: '"o"',
      comment: "dit:0199e2a1-7c00-7a00-8000-0000000000ee",
    });
    t.provider.seed({
      fqdn: `${sub}x.dev-in.tw`,
      type: "TXT",
      ttl: 1,
      content: '"keep"',
      comment: "dit:0199e2a1-7c00-7a00-8000-0000000000ef",
    });
    const inScope = () =>
      [...t.provider.records.values()].filter(
        (p) => p.fqdn === `${sub}.dev-in.tw` || p.fqdn.endsWith(`.${sub}.dev-in.tw`),
      );

    expect(
      (
        await request(t, "POST", `/api/v1/admin/subdomains/${sub}/suspend`, {
          cookie: admin,
          body: { reason: "phishing" },
        })
      ).status,
    ).toBe(200);
    await t.worker.drain();
    expect(inScope()).toHaveLength(0);
    expect([...t.provider.records.values()].some((p) => p.fqdn === `${sub}x.dev-in.tw`)).toBe(true);
    const kept = await t.deps
      .sql`select sync_status, provider_record_id from dns_records r join subdomains s on s.id = r.subdomain_id where s.name = ${sub}`;
    expect(kept).toHaveLength(2);
    expect(kept.every((k) => k.provider_record_id === null && k.sync_status === "pending")).toBe(
      true,
    );

    expect(
      (
        await request(t, "POST", `/api/v1/admin/subdomains/${sub}/unsuspend`, {
          cookie: admin,
          body: {},
        })
      ).status,
    ).toBe(200);
    await t.worker.drain();
    expect(inScope()).toHaveLength(2);
    expect((await row(a.id))?.sync_status).toBe("synced");
  });

  it("releases: purges the provider, deletes the subdomain and holds the name", async () => {
    const sub = await freshSub();
    await record(sub, { type: "A", name: "@", ttl: 1, address: "1.1.1.5" });
    await t.worker.drain();
    await request(t, "POST", `/api/v1/subdomains/${sub}/release`, {
      cookie,
      body: { confirm: sub },
    });
    await t.worker.drain();
    expect([...t.provider.records.values()].some((p) => p.fqdn.endsWith(`${sub}.dev-in.tw`))).toBe(
      false,
    );
    expect(await t.deps.sql`select 1 from subdomains where name = ${sub}`).toHaveLength(0);
    const [hold] = await t.deps.sql`select reason, hold_until from name_holds where name = ${sub}`;
    expect(hold?.reason).toBe("released");
    const days =
      (new Date(hold?.hold_until as string).getTime() - t.clock.now().getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  it("never writes when the subdomain is not active and skips jobs for vanished records", async () => {
    const sub = await freshSub();
    const r = await record(sub, { type: "TXT", name: "skip", ttl: 1, value: "x" });
    await t.deps.sql`update subdomains set status = 'suspended' where name = ${sub}`;
    t.provider.calls.length = 0;
    await t.worker.drain();
    expect(t.provider.calls.filter((c) => c.op === "create")).toHaveLength(0);
    await t.deps
      .sql`insert into dns_sync_jobs (kind, record_id, run_at) values ('upsert_record', '0199e2a1-7c00-7a00-8000-0000000000aa', ${t.clock.now().toISOString()})`;
    await t.deps
      .sql`insert into dns_sync_jobs (kind, record_id, run_at) values ('delete_record', '0199e2a1-7c00-7a00-8000-0000000000ab', ${t.clock.now().toISOString()})`;
    await t.deps
      .sql`insert into dns_sync_jobs (kind, subdomain_id, run_at) values ('purge_subdomain', '0199e2a1-7c00-7a00-8000-0000000000ac', ${t.clock.now().toISOString()})`;
    await t.worker.drain();
    const leftovers = await t.deps
      .sql`select status from dns_sync_jobs where status in ('queued','running')`;
    expect(leftovers).toHaveLength(0);
    expect((await row(r.id))?.sync_status).toBe("pending");
  });

  it("starts, wakes on NOTIFY and stops gracefully", async () => {
    const worker = new SyncWorker(t.deps);
    await worker.start();
    const sub = await freshSub();
    const r = await record(sub, { type: "TXT", name: "notify", ttl: 1, value: "x" });
    for (let i = 0; i < 50 && (await row(r.id))?.sync_status !== "synced"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await row(r.id))?.sync_status).toBe("synced");
    await worker.stop(2000);
  });
});
