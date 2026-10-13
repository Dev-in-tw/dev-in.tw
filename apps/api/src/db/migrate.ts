// 部署時在 server 之前執行（apps/api/Dockerfile）。server 啟動時也會再跑一次（已套用的會跳過）。
import { createDatabase } from "./client.ts";
import { runMigrations } from "./migrator.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(JSON.stringify({ level: "fatal", msg: "migrate: DATABASE_URL is required" }));
  process.exit(1);
}
const database = createDatabase(url, { max: 1 });
try {
  const applied = await runMigrations(database.sql);
  console.log(JSON.stringify({ level: "info", msg: "migrate: done", applied }));
} catch (error) {
  console.error(
    JSON.stringify({ level: "fatal", msg: "migrate: failed", error: (error as Error).message }),
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
