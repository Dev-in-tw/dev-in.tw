import type { ServerEvent } from "@dit/contract";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import type { Executor } from "../db/client.ts";
import type { Logger } from "../lib/logger.ts";

export const EVENTS_CHANNEL = "dit_events";
export const SYNC_CHANNEL = "dns_sync";

type Listener = (event: ServerEvent) => void;

/**
 * 使用者事件匯流排：寫入方在交易內 `pg_notify`（commit 後才送出），每個 API process 以
 * LISTEN 收到後轉給該使用者的 SSE 連線。replicas > 1 時也能運作。
 */
export class EventBus {
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #logger: Logger;
  #unlisten: (() => Promise<void>) | null = null;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async start(sqlClient: postgres.Sql): Promise<void> {
    const sub = await sqlClient.listen(EVENTS_CHANNEL, (payload) => this.#dispatch(payload));
    this.#unlisten = () => sub.unlisten();
  }

  async stop(): Promise<void> {
    await this.#unlisten?.().catch(() => {});
    this.#unlisten = null;
  }

  subscribe(userId: string, listener: Listener): () => void {
    let set = this.#listeners.get(userId);
    if (!set) {
      set = new Set();
      this.#listeners.set(userId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(userId);
    };
  }

  connections(userId: string): number {
    return this.#listeners.get(userId)?.size ?? 0;
  }

  /** 在交易內呼叫：commit 後才會送出；rollback 時不會送 */
  async publish(ex: Executor, userIds: readonly string[], event: ServerEvent): Promise<void> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return;
    const payload = JSON.stringify({ u: unique, e: event });
    await ex.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${payload})`);
  }

  #dispatch(payload: string): void {
    try {
      const { u, e } = JSON.parse(payload) as { u: string[]; e: ServerEvent };
      for (const userId of u) {
        for (const listener of this.#listeners.get(userId) ?? []) listener(e);
      }
    } catch (error) {
      this.#logger.warn({ err: error }, "invalid event payload");
    }
  }
}

/** 喚醒 sync worker（同樣在交易內呼叫） */
export async function wakeWorker(ex: Executor): Promise<void> {
  await ex.execute(sql`select pg_notify(${SYNC_CHANNEL}, '')`);
}
