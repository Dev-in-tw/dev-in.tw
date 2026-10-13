import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { inject } from "vitest";
import { createDatabase, type Database } from "../../src/db/client.ts";

export const pgAvailable = inject("pgAdminUrl") !== null;

/** 每個測試檔一個獨立的 database（從已 migrate 的 template 複製） */
export async function createTestDatabase(): Promise<
  Database & { url: string; drop(): Promise<void> }
> {
  const adminUrl = inject("pgAdminUrl");
  if (!adminUrl) throw new Error("PostgreSQL is not available");
  const name = `dit_t_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name} template ${inject("pgTemplate")}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const database = createDatabase(url.toString(), { max: 10 });
  return {
    ...database,
    url: url.toString(),
    async drop() {
      await database.close();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}
