import { serve } from "@hono/node-server";
import { createDeps, prepare, Scheduler } from "./bootstrap.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createDatabase } from "./db/client.ts";
import { createApp } from "./http/app.ts";
import { createLogger } from "./lib/logger.ts";

// 讀 config → 連 DB → migrate → 確認 zone → 啟動 HTTP → 啟動 worker；SIGTERM 時優雅關閉（PLAN §3.4、§3.13）
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}

const logger = createLogger(config.LOG_LEVEL);
if (config.METRICS_ENABLED)
  logger.warn("METRICS_ENABLED is set but metrics are not implemented yet");
if (config.SENTRY_DSN) logger.warn("SENTRY_DSN is set but error tracking is not implemented yet");

const database = createDatabase(config.DATABASE_URL);
const deps = createDeps(config, database, logger);
const scheduler = new Scheduler(deps);

try {
  await prepare(deps);
  await scheduler.start();
} catch (error) {
  logger.fatal({ err: error }, (error as Error).message);
  await database.close().catch(() => {});
  process.exit(1);
}

const app = createApp(deps);
const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  logger.info(
    {
      port: info.port,
      env: config.NODE_ENV,
      provider: deps.provider.kind,
      worker: config.WORKER_ENABLED,
      dev_login: config.AUTH_DEV_LOGIN,
    },
    "api listening",
  );
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  setTimeout(() => process.exit(1), 25_000).unref();
  server.close();
  await scheduler.stop(20_000);
  await database.close().catch(() => {});
  logger.info("bye");
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
