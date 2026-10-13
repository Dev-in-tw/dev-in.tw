import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../src/db/migrator.ts";

/**
 * 整合測試用的真 PostgreSQL（PLAN §3.12）：
 * 1. 有 TEST_DATABASE_URL 就直接用（CI 的 service container、本機 compose.dev.yml）。
 * 2. 否則找本機的 initdb / pg_ctl，在暫存目錄起一個拋棄式 cluster（fsync off）。
 * 3. 都沒有時：CI 環境直接失敗；本機則讓 DB 測試 skip 並印出警告。
 * migration 只跑一次到 template database，每個測試檔再用 TEMPLATE 複製出自己的 database。
 */

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string | null;
    pgTemplate: string;
  }
}

const TEMPLATE = "dit_test_template";

function findPgBin(): string | null {
  const candidates: string[] = [];
  if (process.env.PG_BIN) candidates.push(process.env.PG_BIN);
  try {
    candidates.push(execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim());
  } catch {}
  const versioned = (base: string, pattern: RegExp) => {
    if (!existsSync(base)) return;
    const dirs = readdirSync(base)
      .filter((d) => pattern.test(d))
      .sort((a, b) => Number(b.replace(/\D/g, "")) - Number(a.replace(/\D/g, "")));
    for (const dir of dirs) candidates.push(join(base, dir, "bin"));
  };
  versioned("/opt/homebrew/opt", /^postgresql@\d+$/);
  versioned("/usr/local/opt", /^postgresql@\d+$/);
  versioned("/usr/lib/postgresql", /^\d+$/);
  for (const dir of (process.env.PATH ?? "").split(":")) candidates.push(dir);
  return candidates.find((dir) => dir && existsSync(join(dir, "initdb"))) ?? null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function startEphemeral(bin: string): Promise<{ url: string; stop: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "dit-pg-"));
  const data = join(dir, "data");
  const port = await freePort();
  const run = (cmd: string, args: string[]) => {
    const res = spawnSync(join(bin, cmd), args, { encoding: "utf8" });
    if (res.status !== 0) throw new Error(`${cmd} failed: ${res.stderr || res.stdout}`);
  };
  run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"]);
  run("pg_ctl", [
    "-D",
    data,
    "-l",
    join(dir, "log"),
    "-w",
    "-o",
    `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200`,
    "start",
  ]);
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop: () => {
      spawnSync(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export default async function setup(project: TestProject) {
  project.provide("pgTemplate", TEMPLATE);
  let adminUrl = process.env.TEST_DATABASE_URL ?? null;
  let stop: (() => void) | undefined;

  if (!adminUrl) {
    const bin = findPgBin();
    if (bin) {
      const pg = await startEphemeral(bin);
      adminUrl = pg.url;
      stop = pg.stop;
    } else if (process.env.CI) {
      throw new Error("整合測試需要 PostgreSQL：請設定 TEST_DATABASE_URL 或安裝 PostgreSQL");
    } else {
      console.warn(
        "\n[api tests] 找不到 PostgreSQL（TEST_DATABASE_URL / initdb），DB 整合測試將被略過\n",
      );
    }
  }

  if (adminUrl) {
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop database if exists ${TEMPLATE} with (force)`);
    await admin.unsafe(`create database ${TEMPLATE}`);
    await admin.end();
    const templateUrl = new URL(adminUrl);
    templateUrl.pathname = `/${TEMPLATE}`;
    const tpl = postgres(templateUrl.toString(), { max: 1, onnotice: () => {} });
    await runMigrations(tpl);
    await tpl.end();
  }
  project.provide("pgAdminUrl", adminUrl);

  return () => stop?.();
}
