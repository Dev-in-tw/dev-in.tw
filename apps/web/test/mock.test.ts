import { describe, expect, it } from "vitest";
import { createMockApp } from "../mock/app.ts";
import { resetState } from "../mock/state.ts";

const ORIGIN = "http://localhost";
const app = createMockApp();

async function login(githubLogin = "alice") {
  const res = await app.request("/api/v1/auth/dev-login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, host: "localhost" },
    body: JSON.stringify({ githubLogin }),
  });
  expect(res.status).toBe(204);
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

const write = (cookie: string, body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: ORIGIN,
    host: "localhost",
    cookie,
    ...extra,
  },
  body: JSON.stringify(body),
});

describe("mock api (contract behaviour)", () => {
  it("answers 404 for someone else's subdomain instead of 403", async () => {
    resetState();
    const cookie = await login("alice");
    const res = await app.request("/api/v1/subdomains/paypa1-shop", {
      headers: { cookie, host: "localhost" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects writes without a matching Origin", async () => {
    resetState();
    const cookie = await login();
    const res = await app.request("/api/v1/subdomains/alice/records", {
      ...write(cookie, { type: "A", name: "x", ttl: 1, address: "1.1.1.1" }),
      headers: {
        "content-type": "application/json",
        host: "localhost",
        cookie,
        origin: "https://evil.dev-in.tw",
      },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "CSRF_REJECTED" });
  });

  it("returns IP_NOT_PUBLIC with a field issue for 10.x", async () => {
    resetState();
    const cookie = await login();
    const res = await app.request(
      "/api/v1/subdomains/alice/records",
      write(cookie, { type: "A", name: "lab", ttl: 1, address: "10.0.0.1" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("IP_NOT_PUBLIC");
    expect(body.errors[0].path).toBe("address");
  });

  it("creates records as pending and enforces If-Match", async () => {
    resetState();
    const cookie = await login();
    const created = await app.request(
      "/api/v1/subdomains/alice/records",
      write(cookie, { type: "A", name: "lab", ttl: 1, address: "1.1.1.1" }),
    );
    expect(created.status).toBe(202);
    const record = await created.json();
    expect(record.syncStatus).toBe("pending");
    const stale = await app.request(`/api/v1/subdomains/alice/records/${record.id}`, {
      ...write(
        cookie,
        { type: "A", name: "lab", ttl: 1, address: "1.1.1.2" },
        { "if-match": '"9"' },
      ),
      method: "PUT",
    });
    expect(stale.status).toBe(412);
  });

  it("can switch P1 endpoints to 501 for degradation tests", async () => {
    resetState();
    const cookie = await login();
    await app.request("/api/__mock/config", {
      method: "POST",
      body: JSON.stringify({ notImplemented: ["listTransfers"] }),
    });
    const res = await app.request("/api/v1/transfers", { headers: { cookie, host: "localhost" } });
    expect(res.status).toBe(501);
    resetState();
  });
});
