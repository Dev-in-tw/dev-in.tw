import type postgres from "postgres";
import { migrations } from "./migrations/index.ts";

/** 任意固定的 64-bit key；start-first 部署時兩個實例同時啟動也只會有一個在跑 migration */
const MIGRATION_LOCK_KEY = 0x6469745f6d6967n; // "dit_mig"

export async function runMigrations(sql: postgres.Sql): Promise<string[]> {
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY.toString()}::bigint)`;
    await tx`create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )`;
    const done = new Set(
      (await tx<{ id: string }[]>`select id from schema_migrations`).map((r) => r.id),
    );
    for (const migration of migrations) {
      if (done.has(migration.id)) continue;
      await tx.unsafe(migration.sql);
      await tx`insert into schema_migrations (id) values (${migration.id})`;
      applied.push(migration.id);
    }
  });
  return applied;
}
