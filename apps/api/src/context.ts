import type postgres from "postgres";
import type { Notifier } from "./adapters/discord/notifier.ts";
import type { DohResolver } from "./adapters/doh/client.ts";
import type { GithubClient } from "./adapters/github/client.ts";
import type { TurnstileVerifier } from "./adapters/turnstile/client.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/client.ts";
import type { Clock } from "./lib/clock.ts";
import type { Logger } from "./lib/logger.ts";
import type { EventBus } from "./sync/events-bus.ts";
import type { DnsProvider } from "./sync/provider-port.ts";

/** 手寫的 composition root 依賴（PLAN §3.4：不引入 DI 框架）。modules/* 只依賴這個型別，不 import hono。 */
export interface Deps {
  config: Config;
  db: Db;
  sql: postgres.Sql;
  provider: DnsProvider;
  clock: Clock;
  logger: Logger;
  notifier: Notifier;
  turnstile: TurnstileVerifier;
  github: GithubClient;
  doh: DohResolver;
  bus: EventBus;
  runtime: RuntimeState;
}

/** process 內的執行狀態（worker 心跳、暫停、最後一次對帳），給 /readyz、/status 使用 */
export interface RuntimeState {
  workerEnabled: boolean;
  workerHeartbeat: Date | null;
  workerPausedUntil: Date | null;
  providerAuthFailed: boolean;
  /** 收到 SIGTERM 後設為 true：SSE 連線結束、背景工作停止排程 */
  stopping: boolean;
  /** 背景工作（admin 觸發的 reconcile 等）；測試可以 await 它們 */
  background: Set<Promise<unknown>>;
}

export const createRuntimeState = (workerEnabled: boolean): RuntimeState => ({
  workerEnabled,
  workerHeartbeat: null,
  workerPausedUntil: null,
  providerAuthFailed: false,
  stopping: false,
  background: new Set(),
});

/** 誰在做這件事（寫稽核紀錄用） */
export interface Actor {
  type: "user" | "admin" | "system";
  userId: string | null;
  ip: string | null;
  requestId: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: "system", userId: null, ip: null, requestId: null };

export function runInBackground(
  deps: Pick<Deps, "runtime" | "logger">,
  work: () => Promise<unknown>,
) {
  const promise = work()
    .catch((error: unknown) => deps.logger.error({ err: error }, "background task failed"))
    .finally(() => deps.runtime.background.delete(promise));
  deps.runtime.background.add(promise);
  return promise;
}
