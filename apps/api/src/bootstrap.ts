import { CloudflareProvider } from "./adapters/cloudflare/provider.ts";
import { DiscordNotifier, type Notifier } from "./adapters/discord/notifier.ts";
import { createDohResolver, type DohResolver } from "./adapters/doh/client.ts";
import {
  createGithubClient,
  type GithubClient,
  unavailableGithubClient,
} from "./adapters/github/client.ts";
import { MemoryDnsProvider } from "./adapters/memory-dns/provider.ts";
import { createTurnstileVerifier, type TurnstileVerifier } from "./adapters/turnstile/client.ts";
import type { Config } from "./config.ts";
import { createRuntimeState, type Deps, runInBackground } from "./context.ts";
import type { Database } from "./db/client.ts";
import { runMigrations } from "./db/migrator.ts";
import { seedReservedNames } from "./db/seed.ts";
import { type Clock, systemClock } from "./lib/clock.ts";
import type { Logger } from "./lib/logger.ts";
import { HOUSEKEEPING_INTERVAL_MS, runHousekeeping } from "./modules/housekeeping.ts";
import { EventBus } from "./sync/events-bus.ts";
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

export function createProvider(config: Config): DnsProvider {
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
  return {
    config,
    db: database.db,
    sql: database.sql,
    logger,
    clock: overrides.clock ?? systemClock,
    provider: overrides.provider ?? createProvider(config),
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
 * 啟動前的準備：migrate → 保留字種子 → 確認 DNS zone（名稱不符就拒絕啟動）→ 匯入 zone 既有名稱 → 快照。
 * 讀不到 provider 時（暫時性錯誤）只記錄警告，不阻擋啟動；zone 名稱不符則一定拒絕。
 */
export async function prepare(deps: Deps): Promise<void> {
  const { logger, config } = deps;
  const applied = await runMigrations(deps.sql);
  if (applied.length > 0) logger.info({ applied }, "migrations applied");
  const seeded = await seedReservedNames(deps.db, config.RESERVED_PRIVATE_SEED_FILE);
  if (seeded > 0) logger.info({ seeded }, "reserved names seeded");

  let zone: Awaited<ReturnType<DnsProvider["zoneInfo"]>>;
  try {
    zone = await deps.provider.zoneInfo();
  } catch (error) {
    if (config.DNS_PROVIDER === "cloudflare") {
      throw new StartupError(
        `無法讀取 Cloudflare zone ${config.CLOUDFLARE_ZONE_ID}：${(error as Error).message}`,
      );
    }
    throw error;
  }
  if (zone.name.toLowerCase() !== config.ROOT_DOMAIN) {
    throw new StartupError(
      `CLOUDFLARE_ZONE_ID 對應的 zone 是 ${zone.name}，與 ROOT_DOMAIN=${config.ROOT_DOMAIN} 不符，拒絕啟動`,
    );
  }
  logger.info(
    {
      provider: deps.provider.kind,
      zone: zone.name,
      zone_id: config.CLOUDFLARE_ZONE_ID ?? null,
      plan: zone.plan,
    },
    "dns provider connected",
  );
  try {
    const records: Parameters<typeof importZoneNames>[1] = [];
    for await (const r of deps.provider.listAll()) records?.push(r);
    const imported = await importZoneNames(deps, records);
    if (imported.length > 0) logger.info({ imported }, "zone names reserved");
    await refreshZoneSnapshot(deps, records);
  } catch (error) {
    logger.warn({ err: error }, "zone import failed; will retry on the next reconcile");
  }
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
