import { Scalar } from "@scalar/hono-api-reference";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Deps } from "../context.ts";
import { AppError, toProblem } from "../lib/problem.ts";
import type { Registry } from "./define.ts";
import type { AppEnv } from "./env.ts";
import {
  clientIp,
  csrf,
  globalRateLimit,
  requestId,
  securityHeaders,
  session,
  wideLog,
} from "./middleware/core.ts";
import { RateLimiter } from "./middleware/rate-limit.ts";
import { buildOpenApi } from "./openapi.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { eventRoutes } from "./routes/events.ts";
import { meRoutes } from "./routes/me.ts";
import { publicRoutes } from "./routes/public.ts";
import { subdomainRoutes } from "./routes/subdomains.ts";

export interface AppOptions {
  limiter?: RateLimiter;
  /** 非 production 預設開啟：回應不符合合約時直接 500 */
  validateResponses?: boolean;
  ssePingMs?: number;
}

async function dbHealthy(deps: Deps): Promise<boolean> {
  try {
    await Promise.race([
      deps.db.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000).unref()),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hono app，所有路由都在 /api 底下（Traefik 不 strip prefix）。中介層順序（PLAN §3.6）：
 * requestId → clientIp → wideLog → securityHeaders → problem（onError）→ session → csrf → rateLimit → route
 */
export function createApp(deps: Deps, options: AppOptions = {}) {
  const app = new Hono<AppEnv>().basePath("/api");
  const reg: Registry = {
    app,
    limiter:
      options.limiter ?? new RateLimiter(Date.now, { enabled: deps.config.RATE_LIMIT_ENABLED }),
    validateResponses: options.validateResponses ?? deps.config.NODE_ENV !== "production",
    registered: new Set(),
  };

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.use("*", requestId());
  app.use("*", clientIp(deps.config.TRUSTED_PROXY_HOPS));
  app.use("*", wideLog());
  app.use("*", securityHeaders());

  app.onError((error, c) => {
    const requestIdValue = c.get("requestId") ?? "unknown";
    let appError: AppError;
    if (error instanceof AppError) {
      appError = error;
    } else if (error instanceof HTTPException && error.status === 413) {
      appError = new AppError("VALIDATION_FAILED", "請求內容太大");
    } else {
      deps.logger.error({ err: error, request_id: requestIdValue }, "unhandled error");
      appError = new AppError("INTERNAL");
    }
    const log = c.get("log");
    if (log) log.error_code = appError.code;
    const problem = toProblem(appError.code, {
      detail: appError.code === "INTERNAL" ? undefined : appError.detail,
      instance: c.req.path,
      requestId: requestIdValue,
      ...appError.options,
    });
    for (const [key, value] of Object.entries(appError.options.headers ?? {})) c.header(key, value);
    return c.body(JSON.stringify(problem), problem.status as 400, {
      "Content-Type": "application/problem+json",
    });
  });
  app.notFound((c) => {
    const problem = toProblem("NOT_FOUND", {
      instance: c.req.path,
      requestId: c.get("requestId") ?? "unknown",
    });
    return c.body(JSON.stringify(problem), 404, { "Content-Type": "application/problem+json" });
  });

  // liveness + DB：Docker HEALTHCHECK 用
  app.get("/healthz", async (c) => {
    const db = await dbHealthy(deps);
    return c.json({ ok: db, db: db ? "ok" : "down" }, db ? 200 : 503);
  });
  // readiness：DB 1 秒內回應、worker 心跳 30 秒內
  app.get("/readyz", async (c) => {
    const db = await dbHealthy(deps);
    const beat = deps.runtime.workerHeartbeat;
    const worker =
      !deps.runtime.workerEnabled ||
      (beat !== null && deps.clock.now().getTime() - beat.getTime() < 30_000);
    const ok = db && worker && !deps.runtime.stopping;
    return c.json({ ok, db: db ? "ok" : "down", worker: worker ? "ok" : "stale" }, ok ? 200 : 503);
  });
  const openapi = buildOpenApi({ serverUrl: deps.config.APP_ORIGIN, version: "1.0.0" });
  app.get("/openapi.json", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json(openapi);
  });
  app.get("/docs", Scalar({ url: "/api/openapi.json", pageTitle: "Dev-in.tw API" }));

  app.use("/v1/*", globalRateLimit(reg.limiter));
  app.use("/v1/*", session());
  app.use("/v1/*", csrf(deps.config.APP_ORIGIN));

  publicRoutes(reg);
  authRoutes(reg);
  meRoutes(reg);
  subdomainRoutes(reg);
  adminRoutes(reg);
  eventRoutes(reg, options.ssePingMs !== undefined ? { pingMs: options.ssePingMs } : {});

  return Object.assign(app, { registered: reg.registered, limiter: reg.limiter });
}

export type App = ReturnType<typeof createApp>;
