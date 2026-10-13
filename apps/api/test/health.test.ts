import { type Endpoint, endpoints } from "@dit/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

describe.skipIf(!pgAvailable)("health, openapi and routing", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(() => t.close());

  it("GET /api/healthz checks the database", async () => {
    const res = await request(t, "GET", "/api/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "ok" });
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("GET /api/readyz reports a stale worker until it has ticked", async () => {
    t.deps.runtime.workerEnabled = true;
    const stale = await request(t, "GET", "/api/readyz");
    expect(stale.status).toBe(503);
    expect(await stale.json()).toMatchObject({ ok: false, db: "ok", worker: "stale" });
    await t.worker.tick();
    const ready = await request(t, "GET", "/api/readyz");
    expect(ready.status).toBe(200);
    t.deps.runtime.workerEnabled = false;
  });

  it("does not serve routes outside /api and answers unknown API paths with a problem", async () => {
    expect((await request(t, "GET", "/healthz")).status).toBe(404);
    const res = await request(t, "GET", "/api/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("propagates a well-formed X-Request-Id and replaces a malformed one", async () => {
    const ok = await request(t, "GET", "/api/v1/meta", {
      headers: { "X-Request-Id": "traefik-abc12345" },
    });
    expect(ok.headers.get("x-request-id")).toBe("traefik-abc12345");
    const bad = await request(t, "GET", "/api/v1/meta", {
      headers: { "X-Request-Id": "<script>" },
    });
    expect(bad.headers.get("x-request-id")).not.toBe("<script>");
  });

  it("registers exactly the endpoints of the contract", () => {
    expect([...t.app.registered].sort()).toEqual(Object.keys(endpoints).sort());
  });

  it("serves an OpenAPI document whose operations equal the endpoint map", async () => {
    const res = await request(t, "GET", "/api/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    const ops = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(
        ([method, op]) => `${op.operationId} ${method.toUpperCase()} ${path}`,
      ),
    );
    const expected = (Object.entries(endpoints) as [string, Endpoint][]).map(
      ([name, ep]) => `${name} ${ep.method} /api/v1${ep.path}`,
    );
    expect(ops.sort()).toEqual(expected.sort());
  });

  it("serves the Scalar API reference", async () => {
    const res = await request(t, "GET", "/api/docs");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/api/openapi.json");
  });
});
