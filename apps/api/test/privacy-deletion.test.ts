import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DiscordNotifier } from "../src/adapters/discord/notifier.ts";
import { HOUR } from "../src/lib/clock.ts";
import { runHousekeeping } from "../src/modules/housekeeping.ts";
import { requeueStuckReleases, stuckRequeueDelay } from "../src/modules/releases/stuck.ts";
import { ProviderError } from "../src/sync/errors.ts";
import { MAX_ATTEMPTS } from "../src/sync/queue.ts";
import { claim, login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

const transient = () => new ProviderError("transient", "http:503", "DNS 服務暫時無法使用");

describe("stuck release backoff", () => {
  it("requeues immediately the first time, then doubles up to a day", () => {
    expect(stuckRequeueDelay(0)).toBe(0);
    expect(stuckRequeueDelay(1)).toBe(HOUR);
    expect(stuckRequeueDelay(2)).toBe(2 * HOUR);
    expect(stuckRequeueDelay(5)).toBe(16 * HOUR);
    expect(stuckRequeueDelay(6)).toBe(24 * HOUR);
    expect(stuckRequeueDelay(50)).toBe(24 * HOUR);
  });
});

/**
 * 隱私權政策第 9 條：刪除帳號後，子網域清除完成就刪除帳號資料。purge 工作重試用完（dead）或遇到
 * 永久錯誤時，子網域不能永遠卡在 releasing、帳號列也不能永遠留著。
 */
describe.skipIf(!pgAvailable)("account deletion with a stuck purge (real PostgreSQL)", () => {
  let t: TestContext;
  let admin: string;
  let n = 0;

  const userRow = async (login: string) =>
    (await t.deps.sql`select * from users where github_login = ${login}`)[0];
  const subRow = async (name: string) =>
    (await t.deps.sql`select * from subdomains where name = ${name}`)[0];
  const purgeJobs = (subId: string) =>
    t.deps
      .sql`select * from dns_sync_jobs where kind = 'purge_subdomain' and subdomain_id = ${subId} order by id`;

  /** 建一個使用者、一個有紀錄的子網域，然後刪除帳號；回傳 login 與子網域 */
  const deletedAccount = async () => {
    n++;
    const who = `gone-${n}`;
    const sub = `gone-sub-${n}`;
    const cookie = await login(t, who);
    await claim(t, cookie, sub);
    const rec = await request(t, "POST", `/api/v1/subdomains/${sub}/records`, {
      cookie,
      body: { type: "A", name: "@", ttl: 1, address: "1.1.1.1" },
    });
    expect(rec.status).toBe(202);
    await t.worker.drain();
    const del = await request(t, "DELETE", "/api/v1/me", { cookie, body: { confirm: who } });
    expect(del.status).toBe(202);
    const row = await subRow(sub);
    return { who, sub, subId: row?.id as string, cookie };
  };

  /** 讓 purge 一直失敗到 dead */
  const killPurge = async () => {
    t.provider.failNext("list", transient(), MAX_ATTEMPTS);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await t.worker.tick();
      t.clock.advance(5 * HOUR);
    }
  };

  beforeAll(async () => {
    t = await setupTestApp();
    admin = await login(t, "HACO8888", { role: "admin" });
  });
  beforeEach(() => {
    t.clock.advance(86_400_000); // 每天 5 次的申請限流
    t.notifier.sent.length = 0;
  });
  afterAll(() => t.close());

  it("requeues the purge with backoff, alerts without personal data, and finally deletes the account", async () => {
    const { who, sub, subId } = await deletedAccount();
    await killPurge();
    const [dead] = await purgeJobs(subId);
    expect(dead).toMatchObject({ status: "dead", attempts: MAX_ATTEMPTS });
    expect((await subRow(sub))?.status).toBe("releasing");

    // 剛 dead 的工作：在退避期間內不重新排入，帳號也還刪不掉
    await t.deps
      .sql`update dns_sync_jobs set updated_at = ${t.clock.now().toISOString()} where id = ${dead?.id}`;
    const first = await runHousekeeping(t.deps);
    expect(first).toMatchObject({ releasesRequeued: 0, usersDeleted: 0 });
    expect(await userRow(who)).toBeDefined();

    // 退避（1 小時）過了：重新排入並告警
    t.clock.advance(HOUR + 60_000);
    const second = await runHousekeeping(t.deps);
    expect(second.releasesRequeued).toBe(1);
    const queued = (await purgeJobs(subId)).filter((j) => j.status === "queued");
    expect(queued).toHaveLength(1);
    const alert = t.notifier.sent.find((a) => a.key === `release-stuck:${subId}`);
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("critical"); // 擁有者正在刪除帳號
    expect(alert?.description).toContain(`${sub}.dev-in.tw`);
    expect(alert?.description).toContain("刪除帳號");
    const payload = JSON.stringify(DiscordNotifier.payload(alert as never));
    expect(payload).not.toMatch(/@example\.com|\d+\.\d+\.\d+\.\d+/);
    const audit = await t.deps
      .sql`select metadata from audit_logs where action = 'subdomain.purge_requeued' and target_id = ${subId}`;
    expect(audit[0]?.metadata).toMatchObject({ failures: 1, ownerDeleting: true });

    // 同一輪不會重複排入
    expect(await requeueStuckReleases(t.deps)).toBe(0);

    // Cloudflare 恢復：清除完成 → 帳號與相關個資真正刪除
    await t.worker.drain();
    expect(await subRow(sub)).toBeUndefined();
    const userId = (await userRow(who))?.id as string;
    const third = await runHousekeeping(t.deps);
    expect(third.usersDeleted).toBeGreaterThanOrEqual(1);
    expect(await userRow(who)).toBeUndefined();
    for (const table of ["sessions", "legal_consents", "idempotency_keys"] as const) {
      const rows = await t.deps.sql`select 1 from ${t.deps.sql(table)} where user_id = ${userId}`;
      expect(rows, table).toHaveLength(0);
    }
    // 稽核紀錄保留，但不再連結到帳號（隱私權政策第 9 條第 3 款）
    const kept = await t.deps
      .sql`select actor_user_id, target_label from audit_logs where action = 'user.delete' and target_id = ${userId}`;
    expect(kept).toEqual([{ actor_user_id: null, target_label: who }]);
    const hold = await t.deps.sql`select previous_owner_id from name_holds where name = ${sub}`;
    expect(hold).toEqual([{ previous_owner_id: null }]);
    const left: string[] = [];
    for await (const r of t.provider.listAll()) left.push(r.fqdn);
    expect(left.filter((f) => f.endsWith(`${sub}.dev-in.tw`))).toEqual([]);
  });

  it("also recovers when the purge ended with a permanent error", async () => {
    const { who, sub, subId } = await deletedAccount();
    t.provider.failNext("list", new ProviderError("permanent", "cf:1000", "bad request", 400));
    await t.worker.tick();
    const [job] = await purgeJobs(subId);
    expect(job).toMatchObject({ status: "done" });
    expect(job?.last_error).toContain("cf:1000");
    expect((await subRow(sub))?.status).toBe("releasing");

    t.clock.advance(2 * HOUR);
    expect((await runHousekeeping(t.deps)).releasesRequeued).toBe(1);
    await t.worker.drain();
    expect(await subRow(sub)).toBeUndefined();
    await runHousekeeping(t.deps);
    expect(await userRow(who)).toBeUndefined();
  });

  it("lets an admin requeue a dead purge right away", async () => {
    const { who, sub, subId } = await deletedAccount();
    await killPurge();
    const [dead] = await purgeJobs(subId);

    // 非管理員看不到這個端點
    const other = await login(t, "nosy-user");
    const denied = await request(t, "POST", `/api/v1/admin/zone/jobs/${dead?.id}/retry`, {
      cookie: other,
    });
    expect(denied.status).toBe(404);

    const res = await request(t, "POST", `/api/v1/admin/zone/jobs/${dead?.id}/retry`, {
      cookie: admin,
    });
    expect(res.status).toBe(204);
    const [requeued] = await purgeJobs(subId);
    expect(requeued).toMatchObject({ id: dead?.id, status: "queued", attempts: 0 });
    const audit = await t.deps
      .sql`select actor_type, metadata from audit_logs where action = 'sync_job.retry' and target_id = ${String(dead?.id)}`;
    expect(audit[0]).toMatchObject({ actor_type: "admin", metadata: { superseded: false } });

    // 已經不是 dead：再按一次是 404
    const again = await request(t, "POST", `/api/v1/admin/zone/jobs/${dead?.id}/retry`, {
      cookie: admin,
    });
    expect(again.status).toBe(404);

    await t.worker.drain();
    expect(await subRow(sub)).toBeUndefined();
    await runHousekeeping(t.deps);
    expect(await userRow(who)).toBeUndefined();
  });

  it("does not queue a duplicate purge when a newer one is already waiting", async () => {
    const { sub, subId } = await deletedAccount();
    await killPurge();
    const [dead] = await purgeJobs(subId);
    t.clock.advance(2 * HOUR);
    expect((await runHousekeeping(t.deps)).releasesRequeued).toBe(1);

    const res = await request(t, "POST", `/api/v1/admin/zone/jobs/${dead?.id}/retry`, {
      cookie: admin,
    });
    expect(res.status).toBe(204);
    const jobs = await purgeJobs(subId);
    expect(jobs.find((j) => j.id === dead?.id)).toMatchObject({ status: "done" });
    expect(jobs.filter((j) => j.status === "queued")).toHaveLength(1);
    await t.worker.drain();
    expect(await subRow(sub)).toBeUndefined();
  });

  it("rejects malformed job ids as not found", async () => {
    const res = await request(t, "POST", "/api/v1/admin/zone/jobs/abc/retry", { cookie: admin });
    expect(res.status).toBe(404);
  });
});
