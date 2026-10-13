import { Hono } from "hono";

/** Hono app，所有路由都在 /api 底下（Traefik 不 strip prefix）。中介層順序見 docs/PLAN.md §3.6。 */
export function createApp() {
  const app = new Hono().basePath("/api");

  // liveness：只確認 process 存活
  app.get("/healthz", (c) => c.json({ ok: true }));

  // TODO(WP-A): /readyz、/openapi.json、/docs 與 /v1/* 路由

  return app;
}

export type App = ReturnType<typeof createApp>;
