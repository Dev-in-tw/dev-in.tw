import type { Context } from "hono";
import type { Actor, Deps } from "../context.ts";
import type { ResolvedSession } from "../modules/identity/sessions.ts";

export interface WideLog {
  user_id?: string;
  subdomain?: string;
  error_code?: string;
  rate_limited?: boolean;
  [key: string]: unknown;
}

export interface AppEnv {
  Variables: {
    deps: Deps;
    requestId: string;
    clientIp: string | null;
    session: ResolvedSession | null;
    log: WideLog;
  };
}

export type AppContext = Context<AppEnv>;

export function actorOf(c: AppContext, type: Actor["type"] = "user"): Actor {
  const session = c.get("session");
  return {
    type: session ? type : "system",
    userId: session?.user.id ?? null,
    ip: c.get("clientIp"),
    requestId: c.get("requestId"),
  };
}
