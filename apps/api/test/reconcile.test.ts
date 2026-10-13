import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryDnsProvider } from "../src/adapters/memory-dns/provider.ts";
import { createDeps, prepare, StartupError } from "../src/bootstrap.ts";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/lib/logger.ts";
import { getSetting } from "../src/modules/settings.ts";
import { importZoneNames, reconcile } from "../src/sync/reconciler.ts";
import { claim, login, request, setupTestApp, type TestContext, testEnv } from "./helpers/app.ts";
import { createTestDatabase, pgAvailable } from "./helpers/db.ts";

const uuid = (i: number) => `0199e2a1-7c00-7a00-8000-${String(i).padStart(12, "0")}`;

describe.skipIf(!pgAvailable)("reconciler", () => {
  let t: TestContext;
  let cookie: string;
  let n = 0;
  const freshSub = async () => {
    n++;
    t.clock.advance(86_400_000);
    await claim(t, cookie, `rc-${n}`);
    return `rc-${n}`;
  };
  const add = async (sub: string, body: Record<string, unknown>) => {
    t.clock.advance(7_000);
    const res = await request(t, "POST", `/api/v1/subdomains/${sub}/records`, { cookie, body });
    expect(res.status).toBe(202);
    return (await res.json()) as { id: string };
  };

  beforeAll(async () => {
    t = await setupTestApp();
    cookie = await login(t, "rc-owner");
    await t.deps.sql`update users set quota_subdomains = 100 where github_login = 'rc-owner'`;
  });
  beforeEach(() => {
    t.provider.records.clear();
  });
  afterAll(() => t.close());

  it("detects and fixes the four kinds of drift", async () => {
    const sub = await freshSub();
    const missing = await add(sub, { type: "A", name: "@", ttl: 1, address: "1.1.1.1" });
    const modified = await add(sub, { type: "TXT", name: "txt", ttl: 1, value: "right" });
    await t.worker.drain();
    // missing：provider 上被刪掉
    const missingRow = await t.deps
      .sql`select provider_record_id from dns_records where id = ${missing.id}`;
    t.provider.records.delete(missingRow[0]?.provider_record_id as string);
    // modified：provider 上被改掉
    const modifiedRow = await t.deps
      .sql`select provider_record_id from dns_records where id = ${modified.id}`;
    const stored = t.provider.records.get(modifiedRow[0]?.provider_record_id as string);
    if (stored) stored.content = '"wrong"';
    // orphan：有 dit: 標記但 DB 沒有；unmanaged：在使用者範圍內但沒有標記
    t.provider.seed({
      fqdn: `old.${sub}.dev-in.tw`,
      type: "TXT",
      ttl: 1,
      content: '"o"',
      comment: `dit:${uuid(1)}`,
    });
    t.provider.seed({
      fqdn: `manual.${sub}.dev-in.tw`,
      type: "A",
      ttl: 1,
      content: "8.8.8.8",
      comment: null,
    });

    const report = await reconcile(t.deps);
    expect(report?.outcome).toBe("ok");
    expect(report?.drift.map((d) => d.kind).sort()).toEqual([
      "missing",
      "modified",
      "orphan",
      "unmanaged",
    ]);
    expect(report?.orphansDeleted).toBe(1);
    await t.worker.drain();

    const values = [...t.provider.records.values()];
    expect(values.some((r) => r.comment === `dit:${uuid(1)}`)).toBe(false);
    expect(values.some((r) => r.fqdn === `manual.${sub}.dev-in.tw`)).toBe(true);
    expect(values.find((r) => r.comment === `dit:${missing.id}`)?.content).toBe("1.1.1.1");
    expect(values.find((r) => r.comment === `dit:${modified.id}`)?.content).toBe('"right"');
    const audit = await t.deps
      .sql`select action from audit_logs where action in ('record.drift_corrected','zone.reconcile')`;
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["record.drift_corrected", "zone.reconcile"]),
    );
    const snapshot = await getSetting(t.deps.db, "zone_snapshot");
    // 快照是對帳當下（孤兒已刪、missing 尚未重建）的狀態；容量閘門只用 unmanagedCount
    expect(snapshot).toMatchObject({ recordCount: 2, unmanagedCount: 1 });
  });

  it("brakes instead of deleting when the database looks empty (mass-delete guard)", async () => {
    const empty = await setupTestApp();
    try {
      for (let i = 0; i < 50; i++) {
        empty.provider.seed({
          fqdn: `user${i}.dev-in.tw`,
          type: "A",
          ttl: 1,
          content: "1.1.1.1",
          comment: `dit:${uuid(100 + i)}`,
        });
      }
      const blocked = await reconcile(empty.deps);
      expect(blocked?.outcome).toBe("blocked");
      expect(blocked?.orphansDeleted).toBe(0);
      expect(empty.provider.records.size).toBe(50);
      expect(
        empty.notifier.sent.some((a) => a.key === "reconcile-blocked" && a.severity === "critical"),
      ).toBe(true);
      const admin = await login(empty, "rc-admin", { role: "admin" });
      const zone = await (
        await request(empty, "GET", "/api/v1/admin/zone", { cookie: admin })
      ).json();
      expect(zone.drift[0].detail).toMatch(/^待確認/);

      const forced = await request(empty, "POST", "/api/v1/admin/zone/reconcile?force=true", {
        cookie: admin,
      });
      expect(forced.status).toBe(202);
      await Promise.all([...empty.deps.runtime.background]);
      expect(empty.provider.records.size).toBe(0);
      const report = await getSetting(empty.deps.db, "reconcile_report");
      expect(report).toMatchObject({ outcome: "ok", forced: true, orphansDeleted: 50 });
    } finally {
      await empty.close();
    }
  });

  it("never touches SYSTEM_RECORD_NAMES, even with a dit: comment and force", async () => {
    const system = [
      t.provider.seed({
        fqdn: "dev-in.tw",
        type: "A",
        ttl: 1,
        content: "203.0.113.1",
        comment: `dit:${uuid(900)}`,
      }),
      t.provider.seed({
        fqdn: "www.dev-in.tw",
        type: "CNAME",
        ttl: 1,
        content: "dev-in.tw",
        comment: null,
      }),
      t.provider.seed({
        fqdn: "_dmarc.dev-in.tw",
        type: "TXT",
        ttl: 1,
        content: '"v=DMARC1"',
        comment: `dit:${uuid(901)}`,
      }),
    ];
    await reconcile(t.deps, { force: true });
    for (const r of system) expect(t.provider.records.has(r.id)).toBe(true);
  });

  it("only allows one reconcile at a time (advisory lock)", async () => {
    const results = await Promise.all([reconcile(t.deps), reconcile(t.deps)]);
    expect(results.filter((r) => r === null).length).toBeGreaterThanOrEqual(0);
    expect(results.some((r) => r !== null)).toBe(true);
  });

  it("records a failed outcome when the provider cannot be listed", async () => {
    t.provider.failNext(
      "list",
      new (await import("../src/sync/errors.ts")).ProviderError("transient", "http:503", "x"),
    );
    const report = await reconcile(t.deps);
    expect(report?.outcome).toBe("failed");
  });

  it("imports existing zone labels as reserved names", async () => {
    t.provider.seed({
      fqdn: "jason.dev-in.tw",
      type: "A",
      ttl: 1,
      content: "1.2.3.4",
      comment: null,
    });
    t.provider.seed({
      fqdn: "deep.testtttt.dev-in.tw",
      type: "A",
      ttl: 1,
      content: "1.2.3.4",
      comment: null,
    });
    t.provider.seed({
      fqdn: "_acme-challenge.dev-in.tw",
      type: "TXT",
      ttl: 1,
      content: '"x"',
      comment: null,
    });
    const imported = await importZoneNames(t.deps);
    expect(imported.sort()).toEqual(["jason", "testtttt"]);
    const rows = await t.deps
      .sql`select category from reserved_names where name in ('jason', 'testtttt')`;
    expect(rows.every((r) => r.category === "zone")).toBe(true);
  });
});

describe.skipIf(!pgAvailable)("startup safety valves", () => {
  it("refuses to start when the provider zone does not match ROOT_DOMAIN", async () => {
    const database = await createTestDatabase();
    try {
      const config = loadConfig(testEnv(database.url));
      const deps = createDeps(config, database, silentLogger, {
        provider: new MemoryDnsProvider({ zoneName: "evil.example" }),
      });
      await expect(prepare(deps)).rejects.toBeInstanceOf(StartupError);
      await expect(prepare(deps)).rejects.toThrow(/ROOT_DOMAIN=dev-in.tw/);
    } finally {
      await database.drop();
    }
  });

  it("migrates, seeds reserved names, imports zone names and snapshots the zone", async () => {
    const database = await createTestDatabase();
    try {
      const config = loadConfig(testEnv(database.url));
      const provider = new MemoryDnsProvider({ zoneName: "dev-in.tw" });
      provider.seed({ fqdn: "dev-in.tw", type: "A", ttl: 1, content: "203.0.113.1" });
      provider.seed({ fqdn: "legacy.dev-in.tw", type: "CNAME", ttl: 1, content: "example.com" });
      const deps = createDeps(config, database, silentLogger, { provider });
      await prepare(deps);
      const [reserved] = await database.sql`select count(*)::int as n from reserved_names`;
      expect(reserved?.n).toBeGreaterThan(200);
      const [legacy] =
        await database.sql`select category from reserved_names where name = 'legacy'`;
      expect(legacy?.category).toBe("zone");
      const snapshot = await getSetting(deps.db, "zone_snapshot");
      expect(snapshot).toMatchObject({ recordCount: 2, unmanagedCount: 2, plan: "memory" });
    } finally {
      await database.drop();
    }
  });
});
