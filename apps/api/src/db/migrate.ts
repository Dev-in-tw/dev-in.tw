// 部署時在 server 之前執行（見 apps/api/Dockerfile）。
// TODO(WP-A): 用 drizzle-orm 的 migrator 跑 db/migrations，並以 pg_advisory_lock 包住（§3.13）
console.log(JSON.stringify({ msg: "migrate: no migrations yet" }));
