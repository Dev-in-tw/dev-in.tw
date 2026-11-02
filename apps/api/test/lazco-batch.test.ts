import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MINUTE, SECOND } from "../src/lib/clock.ts";
import { loadOwnership } from "../src/sync/ownership.ts";
import { reconcile } from "../src/sync/reconciler.ts";
import { claim, request } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";
import { type Lazco, setupLazco, ZONE } from "./helpers/lazco.ts";

describe.skipIf(!pgAvailable)("lazco dns: batched sync", () => {
  let z: Lazco;
  let n = 0;
  const fresh = async () => {
    n++;
    z.t.clock.advance(86_400_000);
    await claim(z.t, z.cookie, `lz-${n}`);
    return `lz-${n}`;
  };
  const add = async (sub: string, body: Record<string, unknown>) => {
    z.t.clock.advance(SECOND);
    const res = await request(z.t, "POST", `/api/v1/subdomains/${sub}/records`, {
      cookie: z.cookie,
      body,
    });
    expect(res.status, await res.clone().text()).toBe(202);
    return (await res.json()) as { id: string; syncStatus: string; syncEta?: string | null };
  };
  const records = async (sub: string) =>
    (
      (await (
        await request(z.t, "GET", `/api/v1/subdomains/${sub}/records`, { cookie: z.cookie })
      ).json()) as {
        items: { id: string; syncStatus: string; syncEta?: string | null; syncError: unknown }[];
      }
    ).items;
  /** 安靜期過後送出一批（並跳過批次間隔） */
  const flush = async () => {
    z.t.clock.advance(20 * MINUTE);
    return z.t.worker.tick();
  };

  beforeAll(async () => {
    z = await setupLazco();
  });
  afterAll(() => z.t.close());
  beforeEach(async () => {
    await z.t.deps.sql`delete from dns_change_budget`;
  });

  it("coalesces a burst of edits into one PATCH and reports the expected sync time", async () => {
    const sub = await fresh();
    const a = await add(sub, { type: "A", name: "@", ttl: 1, address: "203.0.114.1" });
    expect(a.syncStatus).toBe("pending");
    expect(a.syncEta).toEqual(expect.any(String));
    await add(sub, {
      type: "AAAA",
      name: "@",
      ttl: 1,
      address: "2001:db8:1::1".replace("db8", "4860"),
    });
    await add(sub, { type: "TXT", name: "_verify", ttl: 3600, value: "token-123" });
    // 還在安靜期內：不取件、不送出
    expect(await z.t.worker.tick()).toBe(0);
    const before = z.fake.patches;
    z.t.clock.advance(11 * SECOND);
    expect(await z.t.worker.tick()).toBe(3);
    expect(z.fake.patches - before).toBe(1);
    const items = await records(sub);
    expect(items.map((r) => r.syncStatus)).toEqual(["synced", "synced", "synced"]);
    expect(items.every((r) => r.syncEta === undefined)).toBe(true);
    expect(z.fake.get(`${sub}.dev-in.tw`, "A")).toMatchObject({
      ttl: 300,
      values: ["203.0.114.1"],
    });
    expect(z.fake.get(`_verify.${sub}.dev-in.tw`, "TXT")).toMatchObject({
      ttl: 3600,
      values: ['"token-123"'],
    });
  });

  it("waits for the batch interval and shows it as the ETA", async () => {
    const sub = await fresh();
    await add(sub, { type: "A", name: "@", ttl: 1, address: "203.0.114.2" });
    expect(await flush()).toBe(1);
    const created = await add(sub, { type: "A", name: "x", ttl: 1, address: "203.0.114.3" });
    z.t.clock.advance(15 * SECOND);
    // 剛送過一批：下一批要等「今天剩下的時間 ÷ 剩下的額度」
    expect(await z.t.worker.tick()).toBe(0);
    const pending = (await records(sub)).find((r) => r.id === created.id);
    expect(pending?.syncStatus).toBe("pending");
    const eta = new Date(pending?.syncEta ?? 0).getTime();
    expect(eta - z.t.clock.now().getTime()).toBeGreaterThan(10 * MINUTE);
    const status = (await (await request(z.t, "GET", "/api/v1/status")).json()) as {
      syncQueue: { batching: { batchesToday: number; dailyBudget: number; nextBatchAt: string } };
    };
    expect(status.syncQueue.batching).toMatchObject({ batchesToday: 1, dailyBudget: 80 });
    z.t.clock.set(new Date(eta));
    expect(await z.t.worker.tick()).toBe(1);
    expect((await records(sub)).find((r) => r.id === created.id)?.syncStatus).toBe("synced");
  });

  it("pauses at the daily budget and resumes after the next UTC midnight", async () => {
    const sub = await fresh();
    await z.provider.budget.exhaust(z.t.clock.now());
    const rec = await add(sub, { type: "A", name: "@", ttl: 1, address: "203.0.114.4" });
    z.t.deps.runtime.workerEnabled = true;
    z.t.clock.advance(MINUTE);
    expect(await z.t.worker.tick()).toBe(0);
    const [job] = await z.t.deps
      .sql`select attempts from dns_sync_jobs where record_id = ${rec.id}`;
    expect(job?.attempts).toBe(0);
    const status = (await (await request(z.t, "GET", "/api/v1/status")).json()) as {
      components: { id: string; status: string; detail: string | null }[];
      syncQueue: { batching: { pausedUntil: string } };
    };
    expect(status.syncQueue.batching.pausedUntil).toMatch(/T00:01:00\.000Z$/);
    expect(status.components.find((c) => c.id === "sync_worker")?.detail).toContain("額度已用完");
    z.t.clock.set(status.syncQueue.batching.pausedUntil);
    expect(await z.t.worker.tick()).toBe(1);
    z.t.deps.runtime.workerEnabled = false;
    expect((await records(sub))[0]?.syncStatus).toBe("synced");
  });

  it("stops until the next UTC day when Lazco says the daily limit is reached", async () => {
    const sub = await fresh();
    const rec = await add(sub, { type: "A", name: "@", ttl: 1, address: "203.0.114.5" });
    z.fake.setUsedToday(90);
    expect(await flush()).toBe(1);
    const [job] = await z.t.deps
      .sql`select status, attempts, run_at from dns_sync_jobs where record_id = ${rec.id} order by id desc limit 1`;
    expect(job).toMatchObject({ status: "queued", attempts: 0 });
    expect(new Date(job?.run_at as string).toISOString()).toMatch(/T00:01:00\.000Z$/);
    expect((await records(sub))[0]?.syncStatus).toBe("pending");
    expect(z.t.notifier.sent.some((a) => a.key === "dns-daily-batch-limit")).toBe(true);
    const state = await z.provider.budget.state(z.t.clock.now());
    expect(state.usedToday).toBe(80);
    // 延後的工作在 run_at 到了之後一樣要過安靜期
    z.t.clock.set(new Date(new Date(job?.run_at as string).getTime() + 11 * SECOND));
    expect(await z.t.worker.tick()).toBe(1);
    expect((await records(sub))[0]?.syncStatus).toBe("synced");
  });

  it("re-plans on a version conflict and keeps what someone else wrote", async () => {
    const sub = await fresh();
    await add(sub, { type: "A", name: "@", ttl: 1, address: "203.0.114.6" });
    z.fake.fail({
      kind: "concurrent",
      apply: (f) => f.seed(`manual.${sub}.dev-in.tw`, "TXT", ["set in the Lazco panel"]),
    });
    await flush();
    expect((await records(sub))[0]?.syncStatus).toBe("synced");
    expect(z.fake.get(`manual.${sub}.dev-in.tw`, "TXT")).toBeDefined();
  });

  it("drops only the bad record from a batch and sends the rest", async () => {
    const sub = await fresh();
    const good = await add(sub, { type: "A", name: "@", ttl: 1, address: "203.0.114.7" });
    const bad = await add(sub, { type: "TXT", name: "q", ttl: 1, value: "fine for now" });
    const refused = await add(sub, { type: "A", name: "r", ttl: 1, address: "203.0.114.66" });
    // 寫入後才變成 Lazco 不接受的內容（例如規則改變）：送出前的檢查要擋下
    await z.t.deps
      .sql`update dns_records set data = ${JSON.stringify({ value: 'say "hi"' })}::jsonb where id = ${bad.id}`;
    // Dev-in 沒預料到的拒絕：422 的 issues 對回那一筆
    z.fake.rejectValues.add("203.0.114.66");
    await flush();
    const items = await records(sub);
    const byId = new Map(items.map((r) => [r.id, r]));
    expect(byId.get(good.id)?.syncStatus).toBe("synced");
    expect(byId.get(bad.id)).toMatchObject({
      syncStatus: "error",
      syncError: { code: "VALIDATION_FAILED" },
    });
    expect(byId.get(refused.id)).toMatchObject({
      syncStatus: "error",
      syncError: { code: "UPSTREAM_DNS_ERROR" },
    });
    expect(z.fake.get(`${sub}.dev-in.tw`, "A")?.values).toEqual(["203.0.114.7"]);
    z.fake.rejectValues.clear();
  });

  it("keeps writing records that only today's Dev-in rules would refuse (switch-over resync)", async () => {
    const sub = await fresh();
    // MX 先建、之後才把它指向的名稱建成 CNAME：寫入時合法，但完整的 validateRecord 現在會擋 MX
    const mx = await add(sub, {
      type: "MX",
      name: "@",
      ttl: 1,
      priority: 10,
      exchange: `mail.${sub}.dev-in.tw`,
    });
    await add(sub, { type: "CNAME", name: "mail", ttl: 1, target: "mx.example.net" });
    await flush();
    expect((await records(sub)).every((r) => r.syncStatus === "synced")).toBe(true);
    // 切換 provider 後的第一次對帳：provider 上找不到 → 重新排入 → 一樣要寫回去
    z.fake.rrsets.delete(`${sub}.dev-in.tw.|MX`);
    const report = await reconcile(z.t.deps);
    expect(report?.drift).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "missing", type: "MX" })]),
    );
    await flush();
    expect(z.fake.get(`${sub}.dev-in.tw`, "MX")?.values).toEqual([`10 mail.${sub}.dev-in.tw.`]);
    expect((await records(sub)).find((r) => r.id === mx.id)?.syncStatus).toBe("synced");
  });

  it("refuses values Lazco cannot store at write time", async () => {
    const sub = await fresh();
    const res = await request(z.t, "POST", `/api/v1/subdomains/${sub}/records`, {
      cookie: z.cookie,
      body: { type: "TXT", name: "@", ttl: 1, value: 'say "hi"' },
    });
    expect(res.status).toBe(400);
  });

  it("moves a value between RRsets when the type changes, in one PATCH", async () => {
    const sub = await fresh();
    const rec = await add(sub, { type: "A", name: "www", ttl: 1, address: "203.0.114.8" });
    await flush();
    const res = await request(z.t, "PUT", `/api/v1/subdomains/${sub}/records/${rec.id}`, {
      cookie: z.cookie,
      body: { type: "CNAME", name: "www", ttl: 1, target: "alice.github.io" },
    });
    expect(res.status).toBe(202);
    const before = z.fake.patches;
    await flush();
    expect(z.fake.patches - before).toBe(1);
    expect(z.fake.get(`www.${sub}.dev-in.tw`, "A")).toBeUndefined();
    expect(z.fake.get(`www.${sub}.dev-in.tw`, "CNAME")?.values).toEqual(["alice.github.io."]);
    const owned = await loadOwnership(z.t.deps.db, ZONE);
    expect([...owned.keys()].some((id) => id.startsWith(`www.${sub}.dev-in.tw|A|`))).toBe(false);
  });

  it("deletes a record and puts back the same value under a new record", async () => {
    const sub = await fresh();
    const first = await add(sub, { type: "A", name: "@", ttl: 1, address: "203.0.114.11" });
    await flush();
    const del = await request(z.t, "DELETE", `/api/v1/subdomains/${sub}/records/${first.id}`, {
      cookie: z.cookie,
    });
    expect(del.status).toBe(202);
    await add(sub, { type: "A", name: "@", ttl: 1, address: "203.0.114.11" });
    await flush();
    const items = await records(sub);
    expect(items).toHaveLength(1);
    expect(items[0]?.syncStatus).toBe("synced");
    expect(z.fake.get(`${sub}.dev-in.tw`, "A")?.values).toEqual(["203.0.114.11"]);
  });

  it("purges a released subdomain but keeps values nobody in Dev-in wrote", async () => {
    const sub = await fresh();
    await add(sub, { type: "A", name: "@", ttl: 1, address: "203.0.114.12" });
    await add(sub, { type: "TXT", name: "@", ttl: 1, value: "mine" });
    await flush();
    z.fake.seed(`${sub}.dev-in.tw`, "TXT", ["foreign"]);
    // 同一個 RRset 裡混著外來的值
    const txt = z.fake.get(`${sub}.dev-in.tw`, "TXT");
    if (txt) txt.values = ['"foreign"', '"mine"'];
    const res = await request(z.t, "POST", `/api/v1/subdomains/${sub}/release`, {
      cookie: z.cookie,
      body: { confirm: sub },
    });
    expect(res.status).toBe(202);
    await flush();
    expect(z.fake.get(`${sub}.dev-in.tw`, "A")).toBeUndefined();
    expect(z.fake.get(`${sub}.dev-in.tw`, "TXT")?.values).toEqual(['"foreign"']);
    const [gone] = await z.t.deps
      .sql`select count(*)::int as n from subdomains where name = ${sub}`;
    expect(gone?.n).toBe(0);
    const [hold] = await z.t.deps.sql`select reason from name_holds where name = ${sub}`;
    expect(hold?.reason).toBe("released");
  });
});

describe.skipIf(!pgAvailable)("lazco dns: no daily budget (epoch serial mode)", () => {
  let z: Lazco;
  beforeAll(async () => {
    z = await setupLazco("lz-epoch", {
      LAZCO_DNS_DAILY_BATCH_BUDGET: 0,
      LAZCO_DNS_MIN_BATCH_INTERVAL_SECONDS: 40,
    });
  });
  afterAll(() => z.t.close());

  it("sends the next batch after the minimum interval, however many went today", async () => {
    // 一天已經送了很多批：有每日額度時會暫停，這裡不會
    for (let i = 0; i < 120; i++) expect(await z.provider.budget.take(z.t.clock.now())).toBe(true);
    await z.provider.budget.exhaust(z.t.clock.now());
    z.t.clock.advance(86_400_000);
    await claim(z.t, z.cookie, "lz-epoch-1");
    const add = async (address: string) => {
      z.t.clock.advance(SECOND);
      const res = await request(z.t, "POST", "/api/v1/subdomains/lz-epoch-1/records", {
        cookie: z.cookie,
        body: { type: "A", name: `h${address.split(".").at(-1)}`, ttl: 1, address },
      });
      expect(res.status, await res.clone().text()).toBe(202);
      return (await res.json()) as { id: string };
    };
    await add("203.0.114.20");
    z.t.clock.advance(15 * SECOND);
    expect(await z.t.worker.tick()).toBe(1);
    const second = await add("203.0.114.21");
    z.t.clock.advance(15 * SECOND);
    // 安靜期過了，但距離上一批還不到 40 秒
    expect(await z.t.worker.tick()).toBe(0);
    z.t.clock.advance(30 * SECOND);
    expect(await z.t.worker.tick()).toBe(1);
    const [row] = await z.t.deps.sql`select sync_status from dns_records where id = ${second.id}`;
    expect(row?.sync_status).toBe("synced");
    const status = (await (await request(z.t, "GET", "/api/v1/status")).json()) as {
      syncQueue: { batching: { dailyBudget: number; intervalSeconds: number; pausedUntil: null } };
    };
    expect(status.syncQueue.batching).toMatchObject({
      dailyBudget: 0,
      intervalSeconds: 40,
      pausedUntil: null,
    });
  });
});
