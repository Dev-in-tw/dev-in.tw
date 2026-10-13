import type { ServerEvent } from "@dit/contract";
import { streamSSE } from "hono/streaming";
import { AppError } from "../../lib/problem.ts";
import { define, type Registry } from "../define.ts";
import { EVENTS_MAX_CONNECTIONS } from "../middleware/rate-limit.ts";

const PING_MS = 25_000;

/** SSE（PLAN §3.8 / 合約 ServerEvent）：event 名稱 = type，data = JSON；每 25 秒 ping 一次 */
export function eventRoutes(reg: Registry, opts: { pingMs?: number } = {}): void {
  const pingMs = opts.pingMs ?? PING_MS;
  define(reg, "events", async ({ c, user }) => {
    const deps = c.get("deps");
    if (deps.bus.connections(user.id) >= EVENTS_MAX_CONNECTIONS) {
      throw new AppError("RATE_LIMITED", "同時開啟的即時連線太多", {
        retryAfter: 30,
        headers: { "Retry-After": "30" },
      });
    }
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      const send = (event: ServerEvent) => {
        chain = chain
          .then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
          .catch(() => {});
        return chain;
      };
      const unsubscribe = deps.bus.subscribe(user.id, (event) => void send(event));
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      await send({ type: "ping", at: deps.clock.now().toISOString() });
      let sinceLastPing = 0;
      while (!closed && !deps.runtime.stopping) {
        await stream.sleep(1000);
        sinceLastPing += 1000;
        if (sinceLastPing >= pingMs) {
          sinceLastPing = 0;
          await send({ type: "ping", at: deps.clock.now().toISOString() });
        }
      }
      unsubscribe();
    });
  });
}
