import { type EndpointName, endpoints } from "@dit/contract";
import { describe, expect, it } from "vitest";
import { createWebClient, fillPath, toQueryString } from "../lib/api/client.ts";
import { NO_BODY, routes } from "../lib/api/routes.ts";

describe("browser route table", () => {
  it("matches every contract endpoint exactly", () => {
    const names = Object.keys(endpoints).sort();
    expect(Object.keys(routes).sort()).toEqual(names);
    for (const name of names as EndpointName[]) {
      expect(routes[name], name).toEqual([endpoints[name].method, endpoints[name].path]);
    }
  });

  it("marks exactly the endpoints without a JSON body", () => {
    const expected = (Object.keys(endpoints) as EndpointName[]).filter(
      (n) => endpoints[n].response === null,
    );
    expect([...NO_BODY].sort()).toEqual(expected.sort());
  });
});

describe("web client", () => {
  it("fills path params and skips empty query values", () => {
    expect(
      fillPath("/subdomains/{name}/records/{recordId}", { name: "alice", recordId: "a b" }),
    ).toBe("/subdomains/alice/records/a%20b");
    expect(() => fillPath("/subdomains/{name}", {})).toThrow(TypeError);
    expect(toQueryString({ limit: 20, cursor: undefined, q: "" })).toBe("?limit=20");
  });

  it("sends If-Match and Idempotency-Key, and turns problems into ApiError with the code", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createWebClient({
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            type: "x",
            title: "t",
            status: 412,
            code: "VERSION_CONFLICT",
            requestId: "r1",
            detail: "已被修改",
          }),
          { status: 412, headers: { "content-type": "application/problem+json" } },
        );
      },
    });
    await expect(
      client("replaceRecord", {
        params: { name: "alice", recordId: "0199e2a2-1000-7000-8000-000000000003" },
        body: { type: "A", name: "@", ttl: 1, address: "1.1.1.1" },
        ifMatch: 2,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 412, message: "已被修改" });
    const headers = new Headers(calls[0]?.init.headers);
    expect(calls[0]?.url).toBe(
      "/api/v1/subdomains/alice/records/0199e2a2-1000-7000-8000-000000000003",
    );
    expect(calls[0]?.init.method).toBe("PUT");
    expect(headers.get("if-match")).toBe('"2"');
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("synthesizes a problem for non-JSON errors such as a proxy 502", async () => {
    const client = createWebClient({
      fetch: async () => new Response("<html>bad gateway</html>", { status: 501 }),
    });
    await expect(client("getStatus")).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
});
