import { describe, expect, it } from "vitest";
import { DiscordNotifier } from "../src/adapters/discord/notifier.ts";
import { createGithubClient } from "../src/adapters/github/client.ts";
import { MemoryDnsProvider } from "../src/adapters/memory-dns/provider.ts";
import { createTurnstileVerifier } from "../src/adapters/turnstile/client.ts";
import { RateLimiter, RULES } from "../src/http/middleware/rate-limit.ts";
import { ManualClock } from "../src/lib/clock.ts";
import { safeEqual, signPayload, verifyPayload } from "../src/lib/crypto.ts";
import { isUuid, uuidv7 } from "../src/lib/ids.ts";
import { silentLogger } from "../src/lib/logger.ts";
import { approximateIp, hashIp, normalizeIp, resolveClientIp } from "../src/lib/net.ts";
import { TtlCache } from "../src/lib/ttl-cache.ts";
import { ProviderError } from "../src/sync/errors.ts";
import {
  decodeTxt,
  encodeTxt,
  normalizeIPv6,
  sameRecord,
  toProviderInput,
} from "../src/sync/mapper.ts";
import { parseOwnership } from "../src/sync/provider-port.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("lib", () => {
  it("uuidv7 is time-ordered and RFC 9562 shaped", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(isUuid(a)).toBe(true);
    expect(isUuid("nope")).toBe(false);
  });

  it("signs and verifies payloads, rejecting tampering", () => {
    const token = signPayload("secret", { a: 1 });
    expect(verifyPayload("secret", token)).toEqual({ a: 1 });
    expect(verifyPayload("other", token)).toBeNull();
    expect(verifyPayload("secret", `${token}x`)).toBeNull();
    expect(verifyPayload("secret", "no-dot")).toBeNull();
    const [body, mac] = token.split(".");
    expect(verifyPayload("secret", `${body}A.${mac}`)).toBeNull();
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("resolves the client IP from X-Forwarded-For with trusted hops", () => {
    expect(resolveClientIp("1.1.1.1, 2.2.2.2", "10.0.0.1", 1)).toBe("2.2.2.2");
    expect(resolveClientIp("1.1.1.1, 2.2.2.2", "10.0.0.1", 2)).toBe("1.1.1.1");
    expect(resolveClientIp("2.2.2.2", "10.0.0.1", 3)).toBe("2.2.2.2");
    expect(resolveClientIp("1.1.1.1", "::ffff:10.0.0.1", 0)).toBe("10.0.0.1");
    expect(resolveClientIp(undefined, "10.0.0.1", 1)).toBe("10.0.0.1");
    expect(resolveClientIp("garbage", "10.0.0.1", 1)).toBe("10.0.0.1");
    expect(resolveClientIp("[2001:db8::1]", null, 1)).toBe("2001:db8::1");
    expect(normalizeIp("")).toBeNull();
    expect(approximateIp("203.0.113.9")).toBe("203.0.113.x");
    expect(approximateIp("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
    expect(approximateIp(null)).toBeNull();
    expect(hashIp("1.1.1.1", "s")).toHaveLength(32);
    expect(hashIp(null, "s")).toBeNull();
  });

  it("TtlCache expires and evicts", () => {
    let now = 0;
    const cache = new TtlCache<number>(100, 2, () => now);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
    now = 200;
    expect(cache.get("c")).toBeUndefined();
  });

  it("ManualClock advances and sets", () => {
    const clock = new ManualClock("2026-01-01T00:00:00Z");
    clock.advance(1000);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.000Z");
    clock.set("2027-01-01T00:00:00Z");
    expect(clock.now().getUTCFullYear()).toBe(2027);
  });

  it("RateLimiter refills over time and reports Retry-After", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    for (let i = 0; i < 5; i++) expect(limiter.take(RULES.report, "ip").ok).toBe(true);
    const denied = limiter.take(RULES.report, "ip");
    expect(denied).toEqual({ ok: false, retryAfter: 720 });
    now += 720_000;
    expect(limiter.take(RULES.report, "ip").ok).toBe(true);
    now += 2 * 86_400_000;
    expect(limiter.take(RULES.report, "other").ok).toBe(true);
    const off = new RateLimiter(() => 0, { enabled: false });
    for (let i = 0; i < 50; i++) expect(off.take(RULES.report, "ip").ok).toBe(true);
  });
});

describe("mapper", () => {
  it("encodes TXT as quoted 255-byte chunks and decodes it back", () => {
    const long = `${"a".repeat(300)}"\\`;
    const encoded = encodeTxt(long);
    expect(encoded.startsWith(`"${"a".repeat(255)}" "`)).toBe(true);
    expect(decodeTxt(encoded)).toBe(long);
    expect(decodeTxt("plain")).toBe("plain");
  });

  it("maps every record type to provider input and compares with provider state", () => {
    const base = { id: "0199e2a1-7c00-7a00-8000-000000000001", name: "@", ttl: 1 };
    const cases = [
      { type: "A", data: { address: "1.1.1.1" } },
      { type: "AAAA", data: { address: "2606:4700::1111" } },
      { type: "CNAME", data: { target: "alice.github.io" } },
      { type: "TXT", data: { value: "hello" } },
      { type: "MX", data: { priority: 10, exchange: "mx.example.com" } },
      { type: "SRV", data: { priority: 0, weight: 5, port: 443, target: "srv.example.com" } },
      { type: "CAA", data: { flags: 0, tag: "issue", value: "letsencrypt.org" } },
    ] as const;
    for (const c of cases) {
      const input = toProviderInput(
        { ...base, type: c.type, data: { ...c.data } },
        "alice",
        "dev-in.tw",
      );
      expect(input.fqdn).toBe("alice.dev-in.tw");
      expect(input.comment).toBe(`dit:${base.id}`);
      const actual = { ...input, id: "x", modifiedAt: "", comment: input.comment };
      expect(sameRecord(input, actual)).toBe(true);
      expect(sameRecord(input, { ...actual, ttl: 300 })).toBe(false);
    }
    const aaaa = toProviderInput(
      { ...base, type: "AAAA", data: { address: "2606:4700::1111" } },
      "alice",
      "dev-in.tw",
    );
    expect(
      sameRecord(aaaa, { ...aaaa, id: "x", modifiedAt: "", content: "2606:4700:0:0:0:0:0:1111" }),
    ).toBe(true);
    const cname = toProviderInput(
      { ...base, type: "CNAME", data: { target: "a.example.com" } },
      "alice",
      "dev-in.tw",
    );
    expect(
      sameRecord(cname, { ...cname, id: "x", modifiedAt: "", content: "A.example.com." }),
    ).toBe(true);
    expect(sameRecord(cname, { ...cname, id: "x", modifiedAt: "", fqdn: "other.dev-in.tw" })).toBe(
      false,
    );
    expect(normalizeIPv6("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
    expect(normalizeIPv6("bad")).toBe("bad");
    expect(normalizeIPv6(undefined)).toBe("");
  });

  it("parses ownership comments strictly", () => {
    expect(parseOwnership("dit:0199E2A1-7C00-7A00-8000-000000000001")).toBe(
      "0199e2a1-7c00-7a00-8000-000000000001",
    );
    expect(parseOwnership("dit:not-a-uuid")).toBeNull();
    expect(parseOwnership("manual")).toBeNull();
    expect(parseOwnership(null)).toBeNull();
  });
});

describe("memory provider", () => {
  it("behaves like Cloudflare for conflicts, quota, type changes and atomic batches", async () => {
    const p = new MemoryDnsProvider({ zoneName: "dev-in.tw", recordLimit: 3 });
    const a = await p.create({
      fqdn: "a.dev-in.tw",
      type: "A",
      ttl: 1,
      content: "1.1.1.1",
      comment: "dit:x",
    });
    await expect(
      p.create({ fqdn: "a.dev-in.tw", type: "CNAME", ttl: 1, content: "x.com", comment: "c" }),
    ).rejects.toMatchObject({ kind: "permanent" });
    await expect(
      p.create({ fqdn: "a.dev-in.tw", type: "A", ttl: 1, content: "1.1.1.1", comment: "c" }),
    ).rejects.toMatchObject({ providerCode: "mem:duplicate" });
    await expect(
      p.create({ fqdn: "evil.com", type: "A", ttl: 1, content: "1.1.1.1", comment: "c" }),
    ).rejects.toMatchObject({ providerCode: "mem:out_of_zone" });
    await expect(
      p.replace(a.id, { fqdn: "a.dev-in.tw", type: "TXT", ttl: 1, content: "x", comment: "c" }),
    ).rejects.toMatchObject({ providerCode: "mem:type_change" });
    await expect(
      p.replace("missing", { fqdn: "a.dev-in.tw", type: "A", ttl: 1, content: "x", comment: "c" }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await p.create({ fqdn: "b.dev-in.tw", type: "A", ttl: 1, content: "1.1.1.1", comment: "c" });
    await p.create({ fqdn: "c.dev-in.tw", type: "A", ttl: 1, content: "1.1.1.1", comment: "c" });
    await expect(
      p.create({ fqdn: "d.dev-in.tw", type: "A", ttl: 1, content: "1.1.1.1", comment: "c" }),
    ).rejects.toMatchObject({ kind: "capacity" });
    // batch 失敗時不留下部分結果
    await expect(
      p.batch({
        deletes: [a.id],
        replaces: [],
        creates: [{ fqdn: "b.dev-in.tw", type: "CNAME", ttl: 1, content: "x.com", comment: "c" }],
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(p.records.has(a.id)).toBe(true);
    const out = await p.batch({
      deletes: [a.id],
      replaces: [],
      creates: [{ fqdn: "a.dev-in.tw", type: "CNAME", ttl: 1, content: "x.com", comment: "dit:x" }],
    });
    expect(out.created[0]?.type).toBe("CNAME");
    expect((await p.findByComment("dit:x"))?.type).toBe("CNAME");
    expect(await p.zoneInfo()).toEqual({ name: "dev-in.tw", plan: "memory", recordCount: 3 });
    p.failNext("any", new ProviderError("transient", "t", "t"));
    await expect(p.zoneInfo()).rejects.toMatchObject({ kind: "transient" });
    await p.delete("missing");
  });
});

describe("adapters", () => {
  it("Discord notifier sends embeds, throttles by key and never throws", async () => {
    const sent: { url: string; body: unknown }[] = [];
    let now = 0;
    const notifier = new DiscordNotifier({
      webhookUrl: "https://discord.example/webhook",
      logger: silentLogger,
      fetch: async (url, init) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(null, { status: 204 });
      },
      now: () => now,
    });
    notifier.notify({
      key: "k",
      title: "標題",
      description: "說明",
      severity: "critical",
      fields: [{ name: "f", value: "" }],
      url: "https://dev-in.tw/admin",
    });
    notifier.notify({ key: "k", title: "again", description: "x", severity: "info" });
    now += 11 * 60_000;
    notifier.notify({ key: "k", title: "later", description: "x", severity: "info" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body).toMatchObject({
      username: "Dev-in.tw",
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: "標題",
          color: 0xd1432f,
          url: "https://dev-in.tw/admin",
          fields: [{ name: "f", value: "-", inline: false }],
        },
      ],
    });
    const failing = new DiscordNotifier({
      webhookUrl: "https://discord.example/webhook",
      logger: silentLogger,
      fetch: async () => {
        throw new Error("down");
      },
    });
    expect(() =>
      failing.notify({ key: "x", title: "x", description: "x", severity: "warning" }),
    ).not.toThrow();
  });

  it("Turnstile verifies success and hostname and fails closed", async () => {
    const calls: string[] = [];
    const make = (
      body: unknown,
      opts: { skip?: boolean; status?: number; throws?: boolean } = {},
    ) =>
      createTurnstileVerifier({
        secretKey: "secret",
        expectedHostname: "dev-in.tw",
        skipHostnameCheck: opts.skip ?? false,
        fetch: async (_url, init) => {
          if (opts.throws) throw new Error("network");
          calls.push(String(init?.body));
          return json(body, opts.status ?? 200);
        },
      });
    expect(await make({ success: true, hostname: "dev-in.tw" }).verify("tok", "1.1.1.1")).toBe(
      true,
    );
    expect(calls[0]).toContain("remoteip=1.1.1.1");
    expect(await make({ success: true, hostname: "evil.com" }).verify("tok", null)).toBe(false);
    expect(
      await make({ success: true, hostname: "example.com" }, { skip: true }).verify("tok", null),
    ).toBe(true);
    expect(await make({ success: false }).verify("tok", null)).toBe(false);
    expect(await make({}, { status: 500 }).verify("tok", null)).toBe(false);
    expect(await make({}, { throws: true }).verify("tok", null)).toBe(false);
    expect(await make({ success: true }).verify("", null)).toBe(false);
  });

  it("GitHub client exchanges the code with PKCE and reads the primary verified email", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const client = createGithubClient({
      clientId: "id",
      clientSecret: "secret",
      fetch: async (url, init) => {
        requests.push({ url: String(url), ...(init ? { init } : {}) });
        const u = String(url);
        if (u.endsWith("/access_token")) return json({ access_token: "gho_x" });
        if (u.endsWith("/user"))
          return json({
            id: 1,
            login: "octo",
            name: null,
            avatar_url: "https://a/1",
            created_at: "2020-01-01T00:00:00Z",
          });
        return json([
          { email: "unverified@x.com", primary: true, verified: false },
          { email: "octo@x.com", primary: true, verified: true },
        ]);
      },
    });
    const identity = await client.exchange({
      code: "c",
      codeVerifier: "v",
      redirectUri: "https://dev-in.tw/cb",
    });
    expect(identity).toMatchObject({ id: 1, login: "octo", email: "octo@x.com" });
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      code: "c",
      code_verifier: "v",
      redirect_uri: "https://dev-in.tw/cb",
    });
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe("Bearer gho_x");

    const failing = createGithubClient({
      clientId: "id",
      clientSecret: "s",
      fetch: async () => json({ error: "bad_verification_code" }),
    });
    await expect(
      failing.exchange({ code: "c", codeVerifier: "v", redirectUri: "r" }),
    ).rejects.toMatchObject({ code: "UPSTREAM_GITHUB_ERROR" });
    const userFails = createGithubClient({
      clientId: "id",
      clientSecret: "s",
      fetch: async (url) =>
        String(url).endsWith("/access_token") ? json({ access_token: "t" }) : json({}, 500),
    });
    await expect(
      userFails.exchange({ code: "c", codeVerifier: "v", redirectUri: "r" }),
    ).rejects.toMatchObject({ code: "UPSTREAM_GITHUB_ERROR" });
    const network = createGithubClient({
      clientId: "id",
      clientSecret: "s",
      fetch: async () => {
        throw new Error("x");
      },
    });
    await expect(
      network.exchange({ code: "c", codeVerifier: "v", redirectUri: "r" }),
    ).rejects.toMatchObject({ code: "UPSTREAM_GITHUB_ERROR" });
  });
});
