// pnpm --filter @dit/web dev:mock：同時啟動 mock API（:3001）與 next dev（:3000）
import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["mock/server.ts"], {
    stdio: "inherit",
    env: { ...process.env, PORT: "3001" },
  }),
  spawn("pnpm", ["exec", "next", "dev"], {
    stdio: "inherit",
    env: { ...process.env, API_INTERNAL_URL: "http://localhost:3001" },
  }),
];

const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
