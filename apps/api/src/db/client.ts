import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema>;
/** 交易內的 db（drizzle 的 transaction 物件與 Db 有相同的查詢 API） */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export interface Database {
  db: Db;
  sql: postgres.Sql;
  close(): Promise<void>;
}

export function createDatabase(url: string, opts: { max?: number } = {}): Database {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: "dit-api" },
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}

/**
 * raw `sql` 樣板裡的 Date 參數：drizzle 的 postgres-js driver 不會轉換 Date，
 * 一律用這個 helper 轉成 ISO 字串並明確轉型。
 */
export const ts = (date: Date) => sql`${date.toISOString()}::timestamptz`;
