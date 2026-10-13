import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrator.ts";
import { createTestDatabase, pgAvailable } from "./helpers/db.ts";

describe.skipIf(!pgAvailable)("migrations", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(() => database.drop());

  it("are already applied to the template and re-running is a no-op", async () => {
    expect(await runMigrations(database.sql)).toEqual([]);
    const rows = await database.sql`select id from schema_migrations`;
    expect(rows.map((r) => r.id)).toEqual(["0001_init"]);
  });

  it("creates every table from PLAN §3.5", async () => {
    const rows = await database.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by 1`;
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([
        "users",
        "sessions",
        "subdomains",
        "dns_records",
        "dns_sync_jobs",
        "reserved_names",
        "name_holds",
        "transfers",
        "reports",
        "audit_logs",
        "idempotency_keys",
        "settings",
      ]),
    );
  });

  it("enforces the subdomain name check and citext uniqueness", async () => {
    const user = "0199e2a1-7c00-7a00-8000-0000000000aa";
    await database.sql`insert into users (id, github_id, github_login, avatar_url, github_created_at)
      values (${user}, 1, 'alice', 'https://avatars.githubusercontent.com/u/1', now())`;
    await database.sql`insert into subdomains (id, name, owner_id, status)
      values ('0199e2a1-7c00-7a00-8000-0000000000b1', 'alice', ${user}, 'active')`;
    await expect(
      database.sql`insert into subdomains (id, name, owner_id, status)
        values ('0199e2a1-7c00-7a00-8000-0000000000b2', 'ALICE', ${user}, 'active')`,
    ).rejects.toThrow(/unique/);
    await expect(
      database.sql`insert into subdomains (id, name, owner_id, status)
        values ('0199e2a1-7c00-7a00-8000-0000000000b3', 'xn--abc', ${user}, 'active')`,
    ).rejects.toThrow(/check/);
  });
});
