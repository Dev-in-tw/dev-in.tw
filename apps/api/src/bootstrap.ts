import { isNotNull } from "drizzle-orm";
import { CloudflareProvider } from "./adapters/cloudflare/provider.ts";
import { DiscordNotifier, type Notifier } from "./adapters/discord/notifier.ts";
import { createDohResolver, type DohResolver } from "./adapters/doh/client.ts";
import {
  createGithubClient,
  type GithubClient,
  unavailableGithubClient,
} from "./adapters/github/client.ts";
import { LazcoDnsProvider } from "./adapters/lazco-dns/provider.ts";
import { MemoryDnsProvider } from "./adapters/memory-dns/provider.ts";
import { createTurnstileVerifier, type TurnstileVerifier } from "./adapters/turnstile/client.ts";
import { type Config, providerZoneId, systemFqdns } from "./config.ts";
import { createRuntimeState, type Deps, runInBackground } from "./context.ts";
import type { Database, Executor } from "./db/client.ts";
import { runMigrations } from "./db/migrator.ts";
import { dnsRecords } from "./db/schema.ts";
import { seedReservedNames } from "./db/seed.ts";
import { type Clock, systemClock } from "./lib/clock.ts";
import type { Logger } from "./lib/logger.ts";
import { HOUSEKEEPING_INTERVAL_MS, runHousekeeping } from "./modules/housekeeping.ts";
import { getSetting, setSetting } from "./modules/settings.ts";
import { DANGLING_SCAN_INTERVAL_MS, scanDanglingCnames } from "./modules/takeover/dangling.ts";
import { PgChangeBudget } from "./sync/change-budget.ts";
import { asProviderError } from "./sync/errors.ts";
import { EventBus } from "./sync/events-bus.ts";
import { listProviderRecords } from "./sync/ownership.ts";
import type { DnsProvider } from "./sync/provider-port.ts";
import { importZoneNames, reconcile, refreshZoneSnapshot } from "./sync/reconciler.ts";
import { SyncWorker } from "./sync/worker.ts";

export class StartupError extends Error {
  override name = "StartupError";
}

export interface DepsOverrides {
  provider?: DnsProvider;
  clock?: Clock;
  notifier?: Notifier;
  turnstile?: TurnstileVerifier;
  github?: GithubClient;
  doh?: DohResolver;
}

export function createProvider(config: Config, ctx: { db: Executor; clock: Clock }): DnsProvider {
  if (config.DNS_PROVIDER === "lazco") {
    const zoneId = config.LAZCO_DNS_ZONE_ID ?? "";
    return new LazcoDnsProvider({
      token: config.LAZCO_DNS_TOKEN ?? "",
      zoneId,
      apiUrl: config.LAZCO_DNS_API_URL,
      budget: new PgChangeBudget(ctx.db, zoneId, config.LAZCO_DNS_DAILY_BATCH_BUDGET),
      protectedFqdns: systemFqdns(config),
      now: () => ctx.clock.now(),
    });
  }
  if (config.DNS_PROVIDER === "cloudflare") {
    return new CloudflareProvider({
      apiToken: config.CLOUDFLARE_API_TOKEN ?? "",
      zoneId: config.CLOUDFLARE_ZONE_ID ?? "",
      apiBase: config.CLOUDFLARE_API_BASE,
      requestsPerSecond: config.CLOUDFLARE_RPS,
    });
  }
  return new MemoryDnsProvider({
    zoneName: config.ROOT_DOMAIN,
    recordLimit: config.ZONE_RECORD_LIMIT,
  });
}

/** 手寫 composition root：組出所有依賴（測試可以替換任何一個 adapter） */
export function createDeps(
  config: Config,
  database: Database,
  logger: Logger,
  overrides: DepsOverrides = {},
): Deps {
  const clock = overrides.clock ?? systemClock;
  return {
    config,
    db: database.db,
    sql: database.sql,
    logger,
    clock,
    provider: overrides.provider ?? createProvider(config, { db: database.db, clock }),
    notifier:
      overrides.notifier ?? new DiscordNotifier({ webhookUrl: config.DISCORD_WEBHOOK_URL, logger }),
    turnstile:
      overrides.turnstile ??
      createTurnstileVerifier({
        secretKey: config.TURNSTILE_SECRET_KEY,
        expectedHostname: config.TURNSTILE_EXPECTED_HOSTNAME,
        skipHostnameCheck: config.TURNSTILE_IS_TEST_KEY,
      }),
    github:
      overrides.github ??
      (config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET
        ? createGithubClient({
            clientId: config.GITHUB_CLIENT_ID,
            clientSecret: config.GITHUB_CLIENT_SECRET,
          })
        : unavailableGithubClient),
    doh: overrides.doh ?? createDohResolver(),
    bus: new EventBus(logger),
    runtime: createRuntimeState(config.WORKER_ENABLED),
  };
}

/**
 * 讀取 zone 資訊：暫時性錯誤（Cloudflare 短暫故障）以 1、2、4、8 秒退避重試，避免容器重啟時
 * 被短暫的上游問題卡住；認證錯誤或重試用完才拒絕啟動。
 */
async function zoneInfoWithRetry(deps: Deps, delays: readonly number[] = [1000, 2000, 4000, 8000]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.provider.zoneInfo();
    } catch (error) {
      const providerError = asProviderError(error);
      const delay = delays[attempt];
      if (providerError.kind !== "transient" || delay === undefined) {
        throw new StartupError(
          `無法讀取 DNS zone（${deps.config.DNS_PROVIDER} ${providerZoneId(deps.config) ?? ""}）：${providerError.providerCode}`,
        );
      }
      deps.logger.warn(
        { attempt: attempt + 1, provider_error_code: providerError.providerCode },
        "zone info failed; retrying",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * 啟動前的準備：migrate → 保留字種子 → 確認 DNS zone（讀不到或名稱不符就拒絕啟動）→
 * 匯入 zone 既有名稱 → 快照。後兩步失敗只記錄警告，下一輪對帳會再做。
 */
export async function prepare(deps: Deps): Promise<void> {
  const { logger, config } = deps;
  const applied = await runMigrations(deps.sql);
  if (applied.length > 0) logger.info({ applied }, "migrations applied");
  const seeded = await seedReservedNames(deps.db, config.RESERVED_PRIVATE_SEED_FILE);
  if (seeded > 0) logger.info({ seeded }, "reserved names seeded");

  const zone = await zoneInfoWithRetry(deps);
  if (zone.name.toLowerCase().replace(/\.$/, "") !== config.ROOT_DOMAIN) {
    const idVar = config.DNS_PROVIDER === "lazco" ? "LAZCO_DNS_ZONE_ID" : "CLOUDFLARE_ZONE_ID";
    throw new StartupError(
      `${idVar} 對應的 zone 是 ${zone.name}，與 ROOT_DOMAIN=${config.ROOT_DOMAIN} 不符，拒絕啟動`,
    );
  }
  if (zone.capacity !== undefined && config.ZONE_RECORD_LIMIT > zone.capacity) {
    logger.warn(
      { zone_record_limit: config.ZONE_RECORD_LIMIT, provider_capacity: zone.capacity },
      "ZONE_RECORD_LIMIT is above what the DNS provider allows; the provider limit wins",
    );
  }
  logger.info(
    {
      provider: deps.provider.kind,
      zone: zone.name,
      zone_id: providerZoneId(config),
      plan: zone.plan,
    },
    "dns provider connected",
  );
  await resetProviderIdsOnSwitch(deps);
  try {
    const records = await listProviderRecords(deps);
    const imported = await importZoneNames(deps, records);
    if (imported.length > 0) logger.info({ imported }, "zone names reserved");
    await refreshZoneSnapshot(deps, records);
  } catch (error) {
    logger.warn({ err: error }, "zone import failed; will retry on the next reconcile");
  }
}

/**
 * 換了 DNS provider 或 zone（例如 Cloudflare → Lazco DNS，或回滾）：DB 裡的 provider_record_id 是舊
 * provider 的 id，留著會讓 worker 對新 provider 用錯的 id（Cloudflare 的 replace 會 404 後重建、撞上
 * 「已有相同紀錄」）。全部清掉，由對帳把每一筆重新比對（找不到的會重新排入）。
 * 這個版本之前只有 Cloudflare 與 memory，所以第一次啟動就是 lazco 時也當成換過。
 * dns_provider_ownership 不清：它以 zone 區分，切回同一個 Lazco zone 時仍然有效。
 */
export async function resetProviderIdsOnSwitch(deps: Deps): Promise<boolean> {
  const current = { kind: deps.provider.kind, zoneId: providerZoneId(deps.config) };
  const previous = await getSetting(deps.db, "dns_provider");
  const switched = previous
    ? previous.kind !== current.kind || previous.zoneId !== current.zoneId
    : current.kind === "lazco";
  if (switched) {
    const cleared = await deps.db
      .update(dnsRecords)
      .set({ providerRecordId: null, providerType: null })
      .where(isNotNull(dnsRecords.providerRecordId))
      .returning({ id: dnsRecords.id });
    deps.logger.warn(
      { previous, current, cleared: cleared.length },
      "dns provider changed; provider record ids cleared",
    );
  }
  await setSetting(deps.db, "dns_provider", current);
  return switched;
}

/** 背景排程：sync worker、reconciler、housekeeping */
export class Scheduler {
  readonly worker: SyncWorker;
  readonly #deps: Deps;
  readonly #timers: NodeJS.Timeout[] = [];

  constructor(deps: Deps) {
    this.#deps = deps;
    this.worker = new SyncWorker(deps);
  }

  async start(): Promise<void> {
    const deps = this.#deps;
    await deps.bus.start(deps.sql);
    if (!deps.config.WORKER_ENABLED) return;
    await this.worker.start();
    const interval = deps.config.RECONCILE_INTERVAL_SECONDS * 1000;
    if (interval > 0) {
      this.#every(interval, () => reconcile(deps));
      // 啟動後稍等一下再做第一次對帳，讓 worker 先處理積壓的工作
      this.#once(30_000, () => reconcile(deps));
    }
    this.#every(HOUSEKEEPING_INTERVAL_MS, () => runHousekeeping(deps));
    this.#once(60_000, () => runHousekeeping(deps));
    // 接管偵測查的是公開 DNS：memory provider 的紀錄不在公開 DNS 上，一定全部 NXDOMAIN，不跑
    if (deps.config.DNS_PROVIDER !== "memory") {
      this.#every(DANGLING_SCAN_INTERVAL_MS, () => scanDanglingCnames(deps));
      this.#once(5 * 60_000, () => scanDanglingCnames(deps));
    }
  }

  #every(ms: number, work: () => Promise<unknown>) {
    const timer = setInterval(() => {
      if (!this.#deps.runtime.stopping) runInBackground(this.#deps, work);
    }, ms);
    timer.unref();
    this.#timers.push(timer);
  }

  #once(ms: number, work: () => Promise<unknown>) {
    const timer = setTimeout(() => {
      if (!this.#deps.runtime.stopping) runInBackground(this.#deps, work);
    }, ms);
    timer.unref();
    this.#timers.push(timer);
  }

  async stop(timeoutMs = 20_000): Promise<void> {
    this.#deps.runtime.stopping = true;
    for (const timer of this.#timers) clearTimeout(timer);
    await this.worker.stop(timeoutMs);
    await Promise.race([
      Promise.allSettled([...this.#deps.runtime.background]),
      new Promise((r) => setTimeout(r, timeoutMs).unref()),
    ]);
    await this.#deps.bus.stop();
  }
}
