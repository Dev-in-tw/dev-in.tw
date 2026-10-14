import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepare, resetProviderIdsOnSwitch } from "../src/bootstrap.ts";
import { MINUTE, SECOND } from "../src/lib/clock.ts";
import { getSetting, setSetting } from "../src/modules/settings.ts";
import { claimOwnership, loadOwnership } from "../src/sync/ownership.ts";
import { importZoneNames, reconcile } from "../src/sync/reconciler.ts";
import { claim, login, request } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";
import { type Lazco, setupLazco, uuid, ZONE } from "./helpers/lazco.ts";

describe.skipIf(!pgAvailable)("lazco dns: reconcile by database ownership", () => {
  let z: Lazco;
  beforeAll(async () => {
    z = await setupLazco("lz-rc");
  });
  afterAll(() => z.t.close());
  const addRecord = async (sub: string, body: Record<string, unknown>) => {
    z.t.clock.advance(SECOND);
    const res = await request(z.t, "POST", `/api/v1/subdomains/${sub}/records`, {
      cookie: z.cookie,
      body,
    });
    expect(res.status).toBe(202);
  };

  it("uses the smallest TTL for records that share an RRset, and reconciles without drift", async () => {
    const sub = "lzrc-ttl";
    await claim(z.t, z.cookie, sub);
    await addRecord(sub, { type: "A", name: "@", ttl: 3600, address: "203.0.114.9" });
    await addRecord(sub, { type: "A", name: "@", ttl: 120, address: "203.0.114.10" });
    z.t.clock.advance(20 * MINUTE);
    await z.t.worker.tick();
    expect(z.fake.get(`${sub}.dev-in.tw`, "A")).toMatchObject({ ttl: 120 });
    const report = await reconcile(z.t.deps);
    expect(report?.drift.filter((d) => d.fqdn.endsWith(`${sub}.dev-in.tw`))).toEqual([]);
  });

  it("tells managed, orphan and unmanaged values apart without comments", async () => {
    await claim(z.t, z.cookie, "lzrc-one");
    z.t.clock.advance(SECOND);
    const res = await request(z.t, "POST", "/api/v1/subdomains/lzrc-one/records", {
      cookie: z.cookie,
      body: { type: "A", name: "@", ttl: 1, address: "203.0.114.20" },
    });
    const rec = (await res.json()) as { id: string };
    z.t.clock.advance(20 * MINUTE);
    await z.t.worker.tick();
    // orphan：Dev-in 寫過（所有權表有紀錄）但 DB 已經沒有
    z.fake.seed("old.lzrc-one.dev-in.tw", "TXT", ["left behind"]);
    await claimOwnership(z.t.deps.db, ZONE, [
      {
        providerId: "old.lzrc-one.dev-in.tw|TXT|left behind",
        fqdn: "old.lzrc-one.dev-in.tw",
        type: "TXT",
        recordId: uuid(1),
      },
    ]);
    // unmanaged：在使用者範圍內、沒人認領
    z.fake.seed("manual.lzrc-one.dev-in.tw", "A", ["203.0.114.21"]);
    // missing：provider 上被刪掉
    z.fake.rrsets.delete("lzrc-one.dev-in.tw.|A");
    const report = await reconcile(z.t.deps);
    expect(report?.outcome).toBe("ok");
    expect(report?.drift.map((d) => `${d.kind} ${d.fqdn}`).sort()).toEqual([
      "missing lzrc-one.dev-in.tw",
      "orphan old.lzrc-one.dev-in.tw",
      "unmanaged manual.lzrc-one.dev-in.tw",
    ]);
    expect(z.fake.get("old.lzrc-one.dev-in.tw", "TXT")).toBeUndefined();
    expect(z.fake.get("manual.lzrc-one.dev-in.tw", "A")).toBeDefined();
    expect(
      (await loadOwnership(z.t.deps.db, ZONE)).has("old.lzrc-one.dev-in.tw|TXT|left behind"),
    ).toBe(false);
    z.t.clock.advance(20 * MINUTE);
    await z.t.worker.tick();
    expect(z.fake.get("lzrc-one.dev-in.tw", "A")?.values).toEqual(["203.0.114.20"]);
    const [row] = await z.t.deps.sql`select sync_status from dns_records where id = ${rec.id}`;
    expect(row?.sync_status).toBe("synced");
    // 用量以 RRset 計算
    const snapshot = await getSetting(z.t.deps.db, "zone_snapshot");
    // 快照是對帳當下（孤兒已刪、missing 尚未重建）：前一個測試的 A RRset 與手動建立的那一個
    expect(snapshot).toMatchObject({ recordCount: 2, unmanagedCount: 1 });
  });

  it("keeps the mass-delete brake and never touches system names", async () => {
    z.fake.seed("www.dev-in.tw", "CNAME", ["dev-in.tw"]);
    const owned = Array.from({ length: 30 }, (_, i) => {
      z.fake.seed(`ghost${i}.dev-in.tw`, "A", ["203.0.114.30"]);
      return {
        providerId: `ghost${i}.dev-in.tw|A|203.0.114.30`,
        fqdn: `ghost${i}.dev-in.tw`,
        type: "A",
        recordId: uuid(100 + i),
      };
    });
    owned.push({
      providerId: "www.dev-in.tw|CNAME|dev-in.tw",
      fqdn: "www.dev-in.tw",
      type: "CNAME",
      recordId: uuid(99),
    });
    await claimOwnership(z.t.deps.db, ZONE, owned);
    const patches = z.fake.patches;
    const blocked = await reconcile(z.t.deps);
    expect(blocked?.outcome).toBe("blocked");
    expect(z.fake.patches).toBe(patches);
    await reconcile(z.t.deps, { force: true });
    expect(z.fake.get("ghost0.dev-in.tw", "A")).toBeUndefined();
    expect(z.fake.get("www.dev-in.tw", "CNAME")).toBeDefined();
  });

  it("does not import Dev-in users' labels as reserved names", async () => {
    await claim(z.t, z.cookie, "lzrc-two");
    z.fake.seed("lzrc-two.dev-in.tw", "A", ["203.0.114.40"]);
    z.fake.seed("gone-user.dev-in.tw", "A", ["203.0.114.41"]);
    await claimOwnership(z.t.deps.db, ZONE, [
      {
        providerId: "gone-user.dev-in.tw|A|203.0.114.41",
        fqdn: "gone-user.dev-in.tw",
        type: "A",
        recordId: uuid(7),
      },
    ]);
    z.fake.seed("jason.dev-in.tw", "A", ["203.0.114.42"]);
    const imported = await importZoneNames(z.t.deps);
    expect(imported).toContain("jason");
    expect(imported).not.toContain("lzrc-two");
    expect(imported).not.toContain("gone-user");
  });

  it("clears provider record ids when the DNS provider changes", async () => {
    await setSetting(z.t.deps.db, "dns_provider", { kind: "cloudflare", zoneId: "cf-zone" });
    const [before] = await z.t.deps
      .sql`select count(*)::int as n from dns_records where provider_record_id is not null`;
    expect(before?.n).toBeGreaterThan(0);
    expect(await resetProviderIdsOnSwitch(z.t.deps)).toBe(true);
    const [after] = await z.t.deps
      .sql`select count(*)::int as n from dns_records where provider_record_id is not null`;
    expect(after?.n).toBe(0);
    expect(await getSetting(z.t.deps.db, "dns_provider")).toEqual({ kind: "lazco", zoneId: ZONE });
    expect(await resetProviderIdsOnSwitch(z.t.deps)).toBe(false);
    // 換回去之後啟動：zone 名稱檢查、匯入與快照照常
    await prepare(z.t.deps);
  });

  it("shows the provider, unit and budget on the admin zone page", async () => {
    const admin = await login(z.t, "lz-admin", { role: "admin" });
    const zone = (await (
      await request(z.t, "GET", "/api/v1/admin/zone", { cookie: admin })
    ).json()) as Record<string, unknown>;
    expect(zone).toMatchObject({
      provider: "lazco",
      usageUnit: "rrset",
      usage: { limit: 500 },
      batching: { dailyBudget: 80 },
    });
  });
});
