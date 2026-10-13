import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/adapters/cloudflare/client.ts";
import { CloudflareProvider } from "../src/adapters/cloudflare/provider.ts";
import { ProviderError } from "../src/sync/errors.ts";
import { encodeTxt } from "../src/sync/mapper.ts";
import type { ProviderRecordInput } from "../src/sync/provider-port.ts";

type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };
type Reply = { status?: number; json?: unknown; throws?: Error };

function fakeFetch(replies: Reply[] | ((call: Call) => Reply)) {
  const calls: Call[] = [];
  const fn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(call);
    const reply = typeof replies === "function" ? replies(call) : replies.shift();
    if (!reply) throw new Error("unexpected request");
    if (reply.throws) throw reply.throws;
    return new Response(JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fn, calls };
}

const ok = (result: unknown, result_info?: unknown): Reply => ({
  json: { success: true, errors: [], result, ...(result_info ? { result_info } : {}) },
});
const fail = (status: number, code?: number): Reply => ({
  status,
  json: {
    success: false,
    errors: code !== undefined ? [{ code, message: "secret upstream text" }] : [],
    result: null,
  },
});

const cfRecord = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `${id}.alice.dev-in.tw`,
  type: "A",
  ttl: 1,
  content: "185.199.108.153",
  comment: `dit:${id}`,
  modified_on: "2026-10-14T00:00:00Z",
  proxied: false,
  ...extra,
});

function provider(replies: Reply[] | ((call: Call) => Reply)) {
  const f = fakeFetch(replies);
  const p = new CloudflareProvider({
    apiToken: "tok",
    zoneId: "zone123",
    fetch: f.fn,
    requestsPerSecond: 1000,
    sleep: async () => {},
  });
  return { p, calls: f.calls };
}

const input = (over: Partial<ProviderRecordInput> = {}): ProviderRecordInput => ({
  fqdn: "alice.dev-in.tw",
  type: "A",
  ttl: 1,
  content: "185.199.108.153",
  comment: "dit:0199e2a2-1000-7000-8000-000000000001",
  ...over,
});

async function expectProviderError(promise: Promise<unknown>, kind: string, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderError);
  const pe = error as ProviderError;
  expect(pe.kind).toBe(kind);
  expect(pe.providerCode).toBe(code);
  expect(pe.message).not.toContain("secret upstream text");
}

describe("CloudflareProvider", () => {
  it("sends bearer auth and parses the envelope on create", async () => {
    const { p, calls } = provider([ok(cfRecord("r1"))]);
    const created = await p.create(input());
    expect(created).toMatchObject({
      id: "r1",
      fqdn: "r1.alice.dev-in.tw",
      type: "A",
      content: "185.199.108.153",
      comment: "dit:r1",
      modifiedAt: "2026-10-14T00:00:00Z",
    });
    const [call] = calls;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.cloudflare.com/client/v4/zones/zone123/dns_records");
    expect(call?.headers.authorization).toBe("Bearer tok");
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.body).toEqual({
      name: "alice.dev-in.tw",
      type: "A",
      ttl: 1,
      proxied: false,
      comment: "dit:0199e2a2-1000-7000-8000-000000000001",
      content: "185.199.108.153",
    });
  });

  it("builds TXT, MX, SRV and CAA bodies", async () => {
    const { p, calls } = provider(() => ok(cfRecord("x")));
    const long = "a".repeat(300);
    await p.create(input({ type: "TXT", content: encodeTxt(long) }));
    await p.create(input({ type: "MX", content: "mx1.improvmx.com", priority: 10 }));
    const srv = { priority: 0, weight: 5, port: 25565, target: "mc.example.net" };
    await p.create(input({ fqdn: "_minecraft._tcp.alice.dev-in.tw", type: "SRV", data: srv }));
    const caa = { flags: 0, tag: "issue", value: "letsencrypt.org" };
    await p.create(input({ type: "CAA", data: caa }));

    expect(calls[0]?.body).toMatchObject({
      type: "TXT",
      content: `"${"a".repeat(255)}" "aaaaa${"a".repeat(40)}"`,
    });
    expect(calls[1]?.body).toMatchObject({ type: "MX", content: "mx1.improvmx.com", priority: 10 });
    expect(calls[2]?.body).toMatchObject({
      name: "_minecraft._tcp.alice.dev-in.tw",
      type: "SRV",
      data: srv,
    });
    expect(calls[2]?.body).not.toHaveProperty("content");
    expect(calls[3]?.body).toMatchObject({ type: "CAA", data: caa });
  });

  it("maps MX priority and SRV/CAA data when reading records", async () => {
    const { p } = provider([
      ok(
        [
          cfRecord("mx", { type: "MX", content: "mx1.improvmx.com", priority: 10 }),
          cfRecord("srv", {
            type: "SRV",
            content: "5 25565 mc.example.net",
            priority: 0,
            data: { priority: 0, weight: 5, port: 25565, target: "mc.example.net" },
          }),
          cfRecord("ns", {
            name: "Dev-In.TW.",
            type: "NS",
            content: "ns1.cloudflare.com",
            comment: null,
          }),
        ],
        { page: 1, total_pages: 1 },
      ),
    ]);
    const all = [];
    for await (const r of p.listAll()) all.push(r);
    expect(all[0]).toMatchObject({ type: "MX", content: "mx1.improvmx.com", priority: 10 });
    expect(all[1]).toMatchObject({ type: "SRV", data: { port: 25565 } });
    expect(all[1]).not.toHaveProperty("content");
    expect(all[2]).toMatchObject({ fqdn: "dev-in.tw", type: "NS", comment: null });
  });

  it("paginates listAll across three pages", async () => {
    const { p, calls } = provider([
      ok([cfRecord("a"), cfRecord("b")], { page: 1, total_pages: 3 }),
      ok([cfRecord("c")], { page: 2, total_pages: 3 }),
      ok([cfRecord("d")], { page: 3, total_pages: 3 }),
    ]);
    const ids: string[] = [];
    for await (const r of p.listAll()) ids.push(r.id);
    expect(ids).toEqual(["a", "b", "c", "d"]);
    expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("per_page")).toBe("500");
  });

  it("finds a record by exact comment", async () => {
    const { p, calls } = provider([ok([cfRecord("r1")]), ok([])]);
    expect((await p.findByComment("dit:r1"))?.id).toBe("r1");
    expect(await p.findByComment("dit:none")).toBeNull();
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/client/v4/zones/zone123/dns_records");
    expect(url.searchParams.get("comment.exact")).toBe("dit:r1");
    expect(url.searchParams.get("per_page")).toBe("5");
  });

  it("replaces with PUT", async () => {
    const { p, calls } = provider([ok(cfRecord("r1", { content: "1.1.1.1" }))]);
    const r = await p.replace("r1", input({ content: "1.1.1.1" }));
    expect(r.content).toBe("1.1.1.1");
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toMatch(/\/dns_records\/r1$/);
    expect(calls[0]?.body).toMatchObject({ proxied: false, content: "1.1.1.1" });
  });

  it("treats a 404 on delete as success", async () => {
    const { p, calls } = provider([fail(404, 81044), ok({ id: "r2" })]);
    await expect(p.delete("r1")).resolves.toBeUndefined();
    await expect(p.delete("r2")).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
  });

  it("sends the batch shape and omits empty arrays", async () => {
    const { p, calls } = provider([
      ok({ deletes: [{ id: "old" }], puts: [cfRecord("p1")], posts: [cfRecord("n1")] }),
      ok({ posts: [cfRecord("n2")] }),
    ]);
    const res = await p.batch({
      deletes: ["old"],
      replaces: [{ id: "p1", input: input() }],
      creates: [input({ type: "CNAME", content: "alice.github.io" })],
    });
    expect(res.created.map((r) => r.id)).toEqual(["n1"]);
    expect(res.replaced.map((r) => r.id)).toEqual(["p1"]);
    expect(calls[0]?.url).toMatch(/\/zones\/zone123\/dns_records\/batch$/);
    const body = calls[0]?.body as { deletes: unknown; puts: unknown[]; posts: unknown[] };
    expect(body.deletes).toEqual([{ id: "old" }]);
    expect(body.puts).toEqual([
      expect.objectContaining({ id: "p1", proxied: false, comment: input().comment }),
    ]);
    expect(body.posts).toEqual([
      expect.objectContaining({ type: "CNAME", proxied: false, content: "alice.github.io" }),
    ]);

    const second = await p.batch({ deletes: [], replaces: [], creates: [input()] });
    expect(second.created.map((r) => r.id)).toEqual(["n2"]);
    expect(Object.keys(calls[1]?.body as object)).toEqual(["posts"]);

    expect(await p.batch({ deletes: [], replaces: [], creates: [] })).toEqual({
      created: [],
      replaced: [],
    });
    expect(calls).toHaveLength(2);
  });

  it("reads zone info", async () => {
    const { p, calls } = provider([
      ok({ id: "zone123", name: "Dev-in.tw", plan: { legacy_id: "free", name: "Free Website" } }),
      ok([cfRecord("a")], { total_count: 42 }),
    ]);
    expect(await p.zoneInfo()).toEqual({ name: "dev-in.tw", plan: "free", recordCount: 42 });
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/client/v4/zones/zone123");
    expect(new URL(calls[1]?.url ?? "").searchParams.get("per_page")).toBe("1");
  });

  it("falls back to plan name and missing plan", async () => {
    const { p } = provider([
      ok({ name: "dev-in.tw", plan: { name: "Pro" } }),
      ok([], { total_count: 0 }),
      ok({ name: "dev-in.tw", plan: null }),
      ok([]),
    ]);
    expect((await p.zoneInfo()).plan).toBe("Pro");
    expect(await p.zoneInfo()).toEqual({ name: "dev-in.tw", plan: null, recordCount: 0 });
  });

  describe("error classification", () => {
    const cases: [string, Reply, string, string][] = [
      ["401", fail(401), "auth", "http:401"],
      ["403 with code", fail(403, 9109), "auth", "cf:9109"],
      ["auth code on 400", fail(400, 10000), "auth", "cf:10000"],
      ["81045 quota", fail(400, 81045), "capacity", "cf:81045"],
      ["81053 exists", fail(400, 81053), "permanent", "cf:81053"],
      ["81057 conflict", fail(400, 81057), "permanent", "cf:81057"],
      ["9005 validation", fail(400, 9005), "permanent", "cf:9005"],
      ["400 without code", fail(400), "permanent", "http:400"],
      ["404", fail(404), "not_found", "http:404"],
      ["81044", fail(400, 81044), "not_found", "cf:81044"],
      ["429", fail(429), "transient", "http:429"],
      ["503", fail(503), "transient", "http:503"],
      [
        "200 success=false",
        { status: 200, json: { success: false, errors: [], result: null } },
        "transient",
        "http:200",
      ],
      [
        "timeout",
        { throws: Object.assign(new Error("timed out"), { name: "TimeoutError" }) },
        "transient",
        "timeout",
      ],
      [
        "abort",
        { throws: Object.assign(new Error("aborted"), { name: "AbortError" }) },
        "transient",
        "timeout",
      ],
      ["network", { throws: new TypeError("fetch failed") }, "transient", "network"],
    ];
    it.each(cases)("%s", async (_, reply, kind, code) => {
      const { p } = provider([reply]);
      await expectProviderError(p.create(input()), kind, code);
    });

    it("treats a non-JSON 502 as transient", async () => {
      const f = async () => new Response("<html>bad gateway</html>", { status: 502 });
      const p = new CloudflareProvider({
        apiToken: "t",
        zoneId: "z",
        fetch: f,
        sleep: async () => {},
      });
      await expectProviderError(p.zoneInfo(), "transient", "http:502");
    });

    it("propagates non-404 errors from delete", async () => {
      const { p } = provider([fail(503)]);
      await expectProviderError(p.delete("r1"), "transient", "http:503");
    });
  });
});

describe("TokenBucket", () => {
  it("spaces requests at 1/rps intervals", async () => {
    let now = 1000;
    const sleeps: number[] = [];
    const bucket = new TokenBucket(
      3,
      () => now,
      async (ms) => {
        sleeps.push(ms);
      },
    );
    await bucket.take();
    await bucket.take();
    await bucket.take();
    expect(sleeps.map((ms) => Math.round(ms))).toEqual([333, 667]);
    now += 2000;
    await bucket.take();
    expect(sleeps).toHaveLength(2);
  });

  it("is used by the provider for every request", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch(() => ok(cfRecord("r")));
    const p = new CloudflareProvider({
      apiToken: "t",
      zoneId: "z",
      fetch: f.fn,
      requestsPerSecond: 2,
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await p.create(input());
    await p.create(input());
    await p.create(input());
    expect(sleeps).toEqual([500, 1000]);
  });
});
