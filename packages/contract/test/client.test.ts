import { describe, expect, it } from "vitest";
import { ids, problems, responses } from "../src/fixtures.ts";
import { ApiError, createClient, resolvePath, serializeQuery } from "../src/index.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

describe("resolvePath / serializeQuery", () => {
  it("encodes path parameters", () => {
    expect(resolvePath("/availability/{name}", { name: "a b/c" })).toBe("/availability/a%20b%2Fc");
  });

  it("throws on a missing path parameter", () => {
    expect(() => resolvePath("/subdomains/{name}", {})).toThrow(TypeError);
  });

  it("skips undefined and null query values", () => {
    expect(serializeQuery({ cursor: undefined, limit: 20, q: null })).toBe("?limit=20");
    expect(serializeQuery({})).toBe("");
    expect(serializeQuery(undefined)).toBe("");
  });
});

describe("createClient", () => {
  it("builds the URL, headers and body for a write with Idempotency-Key", async () => {
    const { fetch, calls } = fakeFetch(() => json(responses.createRecord, 202));
    const api = createClient({ baseUrl: "/api/v1/", fetch, validateResponses: true });

    const record = await api("createRecord", {
      params: { name: "alice" },
      body: { type: "CNAME", name: "www", ttl: 300, target: "alice.github.io" },
      idempotencyKey: ids.recordCNAME,
    });

    expect(record.syncStatus).toBe("pending");
    const [call] = calls;
    expect(call?.url).toBe("/api/v1/subdomains/alice/records");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.credentials).toBe("same-origin");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Idempotency-Key")).toBe(ids.recordCNAME);
    expect(JSON.parse(String(call?.init.body))).toMatchObject({ type: "CNAME", name: "www" });
  });

  it("quotes If-Match and forwards extra headers", async () => {
    const { fetch, calls } = fakeFetch(() => json(responses.deleteRecord, 202));
    const api = createClient({
      baseUrl: "http://api:3001/api/v1",
      fetch,
      headers: async () => ({ Cookie: "__Host-dit_session=abc" }),
    });

    await api("deleteRecord", { params: { name: "alice", recordId: ids.recordSRV }, ifMatch: 3 });

    const [call] = calls;
    expect(call?.url).toBe(`http://api:3001/api/v1/subdomains/alice/records/${ids.recordSRV}`);
    const headers = new Headers(call?.init.headers);
    expect(headers.get("If-Match")).toBe('"3"');
    expect(headers.get("Cookie")).toBe("__Host-dit_session=abc");
    expect(headers.has("Content-Type")).toBe(false);
  });

  it("serializes query parameters", async () => {
    const { fetch, calls } = fakeFetch(() => json(responses.adminListUsers));
    const api = createClient({ baseUrl: "/api/v1", fetch });
    await api("adminListUsers", { query: { q: "alice", limit: 50 } });
    expect(calls[0]?.url).toBe("/api/v1/admin/users?q=alice&limit=50");
  });

  it("returns undefined for 204 responses", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    const api = createClient({ baseUrl: "/api/v1", fetch });
    await expect(api("logout")).resolves.toBeUndefined();
  });

  it("does not follow redirects for the OAuth start endpoint", async () => {
    const { fetch, calls } = fakeFetch(
      () => new Response(null, { status: 302, headers: { Location: "https://github.com/login" } }),
    );
    const api = createClient({ baseUrl: "/api/v1", fetch });
    await expect(api("startGithubLogin", { query: { redirect: "/dashboard" } })).resolves.toBe(
      undefined,
    );
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.url).toBe("/api/v1/auth/github/start?redirect=%2Fdashboard");
  });

  it("throws ApiError with the server problem", async () => {
    const { fetch } = fakeFetch(() =>
      json(problems.recordConflict, 409, { "Content-Type": "application/problem+json" }),
    );
    const api = createClient({ baseUrl: "/api/v1", fetch });
    const error = await api("createRecord", {
      params: { name: "alice" },
      body: { type: "A", name: "@", ttl: 1, address: "185.199.108.153" },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("RECORD_CONFLICT");
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toBe(problems.recordConflict.detail);
  });

  it("synthesizes a problem when the error body is not problem JSON", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response("<html>Bad Gateway</html>", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "text/html", "X-Request-Id": "req-1" },
        }),
    );
    const api = createClient({ baseUrl: "/api/v1", fetch });
    const error = (await api("getMe").catch((e: unknown) => e)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.problem).toMatchObject({
      status: 502,
      code: "INTERNAL",
      title: "Bad Gateway",
      requestId: "req-1",
      instance: "/api/v1/me",
    });
  });

  it("maps well-known statuses and Retry-After in synthesized problems", async () => {
    const { fetch } = fakeFetch(
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "12" } }),
    );
    const api = createClient({ baseUrl: "/api/v1", fetch });
    const error = (await api("checkAvailability", { params: { name: "alice" } }).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.problem.retryAfter).toBe(12);
  });

  it("validates responses when asked to", async () => {
    const { fetch } = fakeFetch(() => json({ ...responses.getMe, role: "root" }));
    const strict = createClient({ baseUrl: "/api/v1", fetch, validateResponses: true });
    await expect(strict("getMe")).rejects.toThrow();
    const loose = createClient({ baseUrl: "/api/v1", fetch });
    await expect(loose("getMe")).resolves.toMatchObject({ role: "root" });
  });
});
