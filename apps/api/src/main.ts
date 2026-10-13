import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { createApp } from "./http/app.ts";

// TODO(WP-A): 連 DB → 跑 migrate → 啟動 worker；graceful shutdown 時等待執行中的 job（§3.13）
const config = loadConfig();
const app = createApp();

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  console.log(JSON.stringify({ msg: "api listening", port: info.port, env: config.NODE_ENV }));
});

function shutdown(signal: string) {
  console.log(JSON.stringify({ msg: "shutting down", signal }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 20_000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
