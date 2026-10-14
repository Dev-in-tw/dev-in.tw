import type { ServerEvent } from "@dit/contract";
import { streamSSE } from "hono/streaming";
import { rateKeyForIp } from "../../lib/net.ts";
import { AppError } from "../../lib/problem.ts";
import { isSessionActive } from "../../modules/identity/sessions.ts";
import { define, type Registry } from "../define.ts";
import {
  EVENTS_MAX_CONNECTIONS,
  EVENTS_MAX_PER_IP,
  EVENTS_MAX_TOTAL,
} from "../middleware/rate-limit.ts";

const PING_MS = 25_000;
/** 每隔多久重新確認 session（登出、撤銷、停權後不再推送事件） */
const REVALIDATE_MS = 60_000;

export interface StreamLimits {
  perUser: number;
  perIp: number;
  total: number;
}

/**
 * SSE 連線名額。在回應開始串流之前同步保留，避免同時湧入的請求都通過檢查；
 * 連線結束（不論正常或例外）一定要呼叫回傳的 release。
 */
export class StreamSlots {
  readonly #byUser = new Map<string, number>();
  readonly #byIp = new Map<string, number>();
  #total = 0;
  readonly #limits: StreamLimits;

  constructor(limits: StreamLimits) {
    this.#limits = limits;
  }

  get total(): number {
    return this.#total;
  }

  acquire(userId: string, ipKey: string): (() => void) | null {
    const user = this.#byUser.get(userId) ?? 0;
    const ip = this.#byIp.get(ipKey) ?? 0;
    if (
      user >= this.#limits.perUser ||
      ip >= this.#limits.perIp ||
      this.#total >= this.#limits.total
    ) {
      return null;
    }
    this.#byUser.set(userId, user + 1);
    this.#byIp.set(ipKey, ip + 1);
    this.#total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#total -= 1;
      const u = (this.#byUser.get(userId) ?? 1) - 1;
      if (u > 0) this.#byUser.set(userId, u);
      else this.#byUser.delete(userId);
      const i = (this.#byIp.get(ipKey) ?? 1) - 1;
      if (i > 0) this.#byIp.set(ipKey, i);
      else this.#byIp.delete(ipKey);
    };
  }
}

/** SSE（PLAN §3.8 / 合約 ServerEvent）：event 名稱 = type，data = JSON；每 25 秒 ping 一次 */
export function eventRoutes(
  reg: Registry,
  opts: { pingMs?: number; revalidateMs?: number; limits?: Partial<StreamLimits> } = {},
): StreamSlots {
  const pingMs = opts.pingMs ?? PING_MS;
  const revalidateMs = opts.revalidateMs ?? REVALIDATE_MS;
  const slots = new StreamSlots({
    perUser: EVENTS_MAX_CONNECTIONS,
    perIp: EVENTS_MAX_PER_IP,
    total: EVENTS_MAX_TOTAL,
    ...opts.limits,
  });
  define(reg, "events", async ({ c, user, session }) => {
    const deps = c.get("deps");
    const release = slots.acquire(user.id, rateKeyForIp(c.get("clientIp")));
    if (!release) {
      throw new AppError("RATE_LIMITED", "同時開啟的即時連線太多", {
        retryAfter: 30,
        headers: { "Retry-After": "30" },
      });
    }
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");
    try {
      return streamSSE(c, async (stream) => {
        let unsubscribe = () => {};
        try {
          let chain = Promise.resolve();
          const send = (event: ServerEvent) => {
            chain = chain
              .then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
              .catch(() => {});
            return chain;
          };
          unsubscribe = deps.bus.subscribe(user.id, (event) => void send(event));
          let closed = false;
          stream.onAbort(() => {
            closed = true;
          });
          await send({ type: "ping", at: deps.clock.now().toISOString() });
          let sinceLastPing = 0;
          let sinceLastCheck = 0;
          while (!closed && !deps.runtime.stopping) {
            await stream.sleep(1000);
            sinceLastPing += 1000;
            sinceLastCheck += 1000;
            if (sinceLastCheck >= revalidateMs) {
              sinceLastCheck = 0;
              const active = await isSessionActive(deps.db, session.id, deps.clock.now()).catch(
                () => true,
              );
              if (!active) break;
            }
            if (sinceLastPing >= pingMs) {
              sinceLastPing = 0;
              await send({ type: "ping", at: deps.clock.now().toISOString() });
            }
          }
        } finally {
          unsubscribe();
          release();
        }
      });
    } catch (error) {
      release();
      throw error;
    }
  });
  return slots;
}
