// 以和 Dockerfile 相同的方式啟動 standalone build（e2e 使用）：
// 把 .next/static 與 public 複製進 .next/standalone，再執行 apps/web/server.js
import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const standalone = `${web}.next/standalone`;
const server = `${standalone}/apps/web/server.js`;
if (!existsSync(server)) {
  console.error("找不到 standalone build，請先執行 pnpm build");
  process.exit(1);
}
cpSync(`${web}.next/static`, `${standalone}/apps/web/.next/static`, { recursive: true });
cpSync(`${web}public`, `${standalone}/apps/web/public`, { recursive: true });

const child = spawn(process.execPath, [server], {
  stdio: "inherit",
  env: { ...process.env, HOSTNAME: "127.0.0.1" },
});
const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
