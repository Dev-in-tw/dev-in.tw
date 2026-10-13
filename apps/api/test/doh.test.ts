import { describe, expect, it } from "vitest";
import { createDohResolver, presentAnswer, RESOLVERS } from "../src/adapters/doh/client.ts";
import {
  DnsWireError,
  decodeResponse,
  encodeQuery,
  TYPE_CODES,
} from "../src/adapters/doh/dns-wire.ts";

// ── 手工組 DNS 回應封包 ─────────────────────────────────────
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [...u16(Math.floor(n / 0x10000)), ...u16(n & 0xffff)];
const label = (s: string) => [s.length, ...Buffer.from(s)];
const name = (s: string) => [...s.split(".").flatMap(label), 0];
const ptr = (offset: number) => [0xc0 | (offset >> 8), offset & 0xff];

/** header(12) + question，question 名稱固定從 offset 12 開始，方便用 ptr(12) 壓縮 */
function response(opts: {
  qname: string;
  qtype: number;
  rcode?: number;
  answers?: { name: number[]; type: number; ttl?: number; rdata: number[] }[];
}): Uint8Array {
  const answers = opts.answers ?? [];
  const bytes = [
    ...u16(0x1234),
    0x81,
    0x80 | (opts.rcode ?? 0),
    ...u16(1),
    ...u16(answers.length),
    ...u16(0),
    ...u16(0),
    ...name(opts.qname),
    ...u16(opts.qtype),
    ...u16(1),
  ];
  for (const a of answers) {
    bytes.push(
      ...a.name,
      ...u16(a.type),
      ...u16(1),
      ...u32(a.ttl ?? 300),
      ...u16(a.rdata.length),
      ...a.rdata,
    );
  }
  return Uint8Array.from(bytes);
}

describe("encodeQuery", () => {
  it("builds a recursive query with EDNS0", () => {
    const q = encodeQuery("www.alice.dev-in.tw.", "AAAA", 0xbeef);
    expect(Array.from(q.slice(0, 12))).toEqual([0xbe, 0xef, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 1]);
    const qname = [...name("www.alice.dev-in.tw")];
    expect(Array.from(q.slice(12, 12 + qname.length))).toEqual(qname);
    expect(Array.from(q.slice(12 + qname.length, 16 + qname.length))).toEqual([0, 28, 0, 1]);
    expect(q.length).toBe(16 + qname.length + 11);
    expect(q[16 + qname.length + 2]).toBe(TYPE_CODES.OPT);
  });

  it("omits OPT when edns is false and accepts numeric types", () => {
    const q = encodeQuery("a.b", 257, 0, false);
    expect(q[11]).toBe(0);
    expect(q.length).toBe(12 + name("a.b").length + 4);
  });

  it("rejects invalid labels", () => {
    expect(() => encodeQuery("a..b", "A")).toThrow(DnsWireError);
    expect(() => encodeQuery(`${"a".repeat(64)}.tw`, "A")).toThrow(DnsWireError);
    expect(() => encodeQuery(Array(130).fill("ab").join("."), "A")).toThrow(DnsWireError);
  });

  it("encodes the root name", () => {
    expect(encodeQuery("", "A", 0, false).length).toBe(17);
  });
});

describe("decodeResponse", () => {
  const q = "alice.dev-in.tw";

  it("decodes every supported type with compression pointers", () => {
    const qlen = name(q).length;
    const cnameRdataOffset = 12 + qlen + 4 + 2 + 10; // 第一個 answer 的 rdata 起點
    const msg = response({
      qname: q,
      qtype: 1,
      answers: [
        {
          name: ptr(12),
          type: 5,
          rdata: [...label("alice"), ...label("github"), ...label("io"), 0],
        },
        { name: ptr(cnameRdataOffset), type: 1, ttl: 60, rdata: [185, 199, 108, 153] },
        {
          name: ptr(12),
          type: 28,
          rdata: [0x26, 0x06, 0x50, 0xc0, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x53],
        },
        { name: ptr(12), type: 16, rdata: [...label("hello "), ...label("world")] },
        { name: ptr(12), type: 15, rdata: [...u16(10), ...label("mx1"), ...ptr(12 + 6)] },
        {
          name: [...label("_minecraft"), ...label("_tcp"), ...ptr(12)],
          type: 33,
          rdata: [...u16(0), ...u16(5), ...u16(25565), ...name("mc.example.net")],
        },
        {
          name: ptr(12),
          type: 257,
          rdata: [0, 5, ...Buffer.from("issue"), ...Buffer.from("letsencrypt.org")],
        },
        { name: ptr(12), type: 99, rdata: [0xde, 0xad] },
      ],
    });
    const res = decodeResponse(msg);
    expect(res.id).toBe(0x1234);
    expect(res.rcode).toBe(0);
    expect(res.answers).toEqual([
      { name: q, type: "CNAME", ttl: 300, data: { target: "alice.github.io" } },
      { name: "alice.github.io", type: "A", ttl: 60, data: { address: "185.199.108.153" } },
      { name: q, type: "AAAA", ttl: 300, data: { address: "2606:50c0:8000::153" } },
      { name: q, type: "TXT", ttl: 300, data: { value: "hello world" } },
      { name: q, type: "MX", ttl: 300, data: { priority: 10, exchange: "mx1.dev-in.tw" } },
      {
        name: `_minecraft._tcp.${q}`,
        type: "SRV",
        ttl: 300,
        data: { priority: 0, weight: 5, port: 25565, target: "mc.example.net" },
      },
      {
        name: q,
        type: "CAA",
        ttl: 300,
        data: { flags: 0, tag: "issue", value: "letsencrypt.org" },
      },
      { name: q, type: "TYPE99", ttl: 300, data: { hex: "dead" } },
    ]);
  });

  it("formats IPv6 per RFC 5952", () => {
    const aaaa = (bytes: number[]) =>
      decodeResponse(
        response({ qname: q, qtype: 28, answers: [{ name: ptr(12), type: 28, rdata: bytes }] }),
      ).answers[0]?.data.address;
    expect(aaaa([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1])).toBe(
      "2001:db8:0:1::1",
    );
    expect(aaaa([0x20, 0x01, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7])).toBe("2001:1:2:3:4:5:6:7");
    expect(aaaa([0x20, 0x01, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1])).toBe("2001:0:1:1:1:1:1:1");
  });

  it("reports NXDOMAIN rcode", () => {
    expect(decodeResponse(response({ qname: q, qtype: 1, rcode: 3 })).rcode).toBe(3);
  });

  it("accepts ArrayBuffer input", () => {
    const msg = response({ qname: q, qtype: 1 });
    expect(decodeResponse(msg.buffer.slice(0) as ArrayBuffer).answers).toEqual([]);
  });

  it("throws on truncated input", () => {
    const msg = response({
      qname: q,
      qtype: 1,
      answers: [{ name: ptr(12), type: 1, rdata: [1, 2, 3, 4] }],
    });
    for (const len of [0, 5, 12, 20, msg.length - 2]) {
      expect(() => decodeResponse(msg.slice(0, len))).toThrow(DnsWireError);
    }
  });

  it("throws on compression pointer loops instead of hanging", () => {
    const msg = response({
      qname: q,
      qtype: 1,
      answers: [{ name: [0xc0, 12 + name(q).length + 4], type: 1, rdata: [] }],
    });
    // 讓 answer 名稱的指標指向自己
    expect(() => decodeResponse(msg)).toThrow(/loop/);
  });

  it("throws on queries, bad label types and bad rdata", () => {
    const query = encodeQuery(q, "A");
    expect(() => decodeResponse(query)).toThrow(/not a response/);
    const badLabel = response({
      qname: q,
      qtype: 1,
      answers: [{ name: [0x80], type: 1, rdata: [] }],
    });
    expect(() => decodeResponse(badLabel)).toThrow(/label type/);
    const badA = response({
      qname: q,
      qtype: 1,
      answers: [{ name: ptr(12), type: 1, rdata: [1, 2] }],
    });
    expect(() => decodeResponse(badA)).toThrow(/A rdata/);
    const badAAAA = response({
      qname: q,
      qtype: 28,
      answers: [{ name: ptr(12), type: 28, rdata: [1] }],
    });
    expect(() => decodeResponse(badAAAA)).toThrow(/AAAA rdata/);
    const badTxt = response({
      qname: q,
      qtype: 16,
      answers: [{ name: ptr(12), type: 16, rdata: [9, 1] }],
    });
    expect(() => decodeResponse(badTxt)).toThrow(/TXT rdata/);
    const badCaa = response({
      qname: q,
      qtype: 257,
      answers: [{ name: ptr(12), type: 257, rdata: [0, 9, 1] }],
    });
    expect(() => decodeResponse(badCaa)).toThrow(/CAA rdata/);
    const overrun = response({
      qname: q,
      qtype: 5,
      answers: [{ name: ptr(12), type: 5, rdata: [3, 0x61, 0x62, 0x63] }],
    });
    expect(() => decodeResponse(overrun)).toThrow(DnsWireError);
  });
});

describe("presentAnswer", () => {
  it("formats each type", () => {
    expect(presentAnswer("A", { address: "1.2.3.4" })).toBe("1.2.3.4");
    expect(presentAnswer("AAAA", { address: "2606:50C0:8000:0:0:0:0:153" })).toBe(
      "2606:50c0:8000::153",
    );
    expect(presentAnswer("CNAME", { target: "Alice.GitHub.io." })).toBe("alice.github.io");
    expect(presentAnswer("TXT", { value: "v=spf1 -all" })).toBe("v=spf1 -all");
    expect(presentAnswer("MX", { priority: 10, exchange: "MX1.improvmx.com." })).toBe(
      "10 mx1.improvmx.com",
    );
    expect(
      presentAnswer("SRV", { priority: 0, weight: 5, port: 25565, target: "mc.example.net." }),
    ).toBe("0 5 25565 mc.example.net");
    expect(presentAnswer("CAA", { flags: 0, tag: "issue", value: "letsencrypt.org" })).toBe(
      '0 issue "letsencrypt.org"',
    );
  });
});

describe("createDohResolver", () => {
  const q = "www.alice.dev-in.tw";
  const cnameThenA = response({
    qname: q,
    qtype: 1,
    answers: [
      { name: ptr(12), type: 5, rdata: name("alice.github.io") },
      { name: name("alice.github.io"), type: 1, rdata: [185, 199, 108, 153] },
      { name: name("alice.github.io"), type: 1, rdata: [185, 199, 108, 153] },
    ],
  });

  const fetchReturning =
    (body: Uint8Array | null, status = 200, seen: string[] = []) =>
    async (input: string | URL, init?: RequestInit) => {
      seen.push(String(input));
      expect(new Headers(init?.headers).get("accept")).toBe("application/dns-message");
      return new Response(body ? Buffer.from(body) : null, { status });
    };

  it("lists the four resolvers", () => {
    expect(RESOLVERS.map((r) => r.id)).toEqual(["cloudflare", "google", "quad9", "quad101"]);
    expect(RESOLVERS.find((r) => r.id === "quad101")?.label).toBe("TWNIC Quad101");
  });

  it("queries with RFC 8484 GET and keeps only the requested type", async () => {
    const seen: string[] = [];
    let t = 0;
    const doh = createDohResolver({
      fetch: fetchReturning(cnameThenA, 200, seen),
      now: () => (t += 7),
    });
    const a = await doh.query("quad101", q, "A");
    expect(a).toEqual({ answers: ["185.199.108.153"], latencyMs: 7, error: null });
    const url = new URL(seen[0] ?? "");
    expect(url.origin + url.pathname).toBe("https://dns.twnic.tw/dns-query");
    const dns = url.searchParams.get("dns") ?? "";
    expect(dns).not.toMatch(/[=+/]/);
    expect(Buffer.from(dns, "base64url")).toEqual(Buffer.from(encodeQuery(q, "A", 0)));

    const cname = await doh.query("cloudflare", q, "CNAME");
    expect(cname.answers).toEqual(["alice.github.io"]);
  });

  it("returns no answers and no error for NXDOMAIN", async () => {
    const doh = createDohResolver({
      fetch: fetchReturning(response({ qname: q, qtype: 1, rcode: 3 })),
    });
    expect(await doh.query("google", q, "A")).toMatchObject({ answers: [], error: null });
  });

  it("reports SERVFAIL, HTTP errors, garbage, timeouts and unknown resolvers without throwing", async () => {
    const servfail = createDohResolver({
      fetch: fetchReturning(response({ qname: q, qtype: 1, rcode: 2 })),
    });
    expect(await servfail.query("quad9", q, "A")).toMatchObject({ answers: [], error: "查詢失敗" });

    const http = createDohResolver({ fetch: fetchReturning(null, 502) });
    expect(await http.query("quad9", q, "A")).toMatchObject({ answers: [], error: "查詢失敗" });

    const garbage = createDohResolver({ fetch: fetchReturning(Uint8Array.from([1, 2, 3])) });
    expect(await garbage.query("quad9", q, "A")).toMatchObject({
      error: "查詢失敗",
      latencyMs: null,
    });

    const slow = createDohResolver({
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    expect(await slow.query("cloudflare", q, "A")).toEqual({
      answers: [],
      latencyMs: null,
      error: "逾時",
    });

    const doh = createDohResolver({ fetch: fetchReturning(cnameThenA) });
    // @ts-expect-error unknown resolver id
    expect(await doh.query("opendns", q, "A")).toMatchObject({ error: "未知的 resolver" });
  });
});
