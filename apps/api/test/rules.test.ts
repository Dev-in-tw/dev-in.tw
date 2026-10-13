import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setSetting } from "../src/modules/settings.ts";
import { claim, login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

const availability = async (t: TestContext, name: string, cookie?: string) => {
  const res = await request(
    t,
    "GET",
    `/api/v1/availability/${encodeURIComponent(name)}`,
    cookie ? { cookie } : {},
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    name: string;
    status: string;
    reason?: string;
    reviewReasons?: string[];
    suggestions: string[];
  };
};

describe.skipIf(!pgAvailable)("naming and record rules through the API", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(() => t.close());

  describe("availability", () => {
    it("never sends the ordinary-name guard list to review (PLAN §3.9)", async () => {
      const cookie = await login(t, "guard-user");
      for (const name of "alex nextjs pipeline online olive metal bird laws api-tools xavier linear postgres pixel".split(
        " ",
      )) {
        const result = await availability(t, name, cookie);
        expect(result.status, name).toBe("available");
      }
    });

    it("sends brand look-alikes to review and keeps exact brands reserved", async () => {
      for (const name of ["g00gle", "paypa1", "paypal-login", "faceb00k"]) {
        const result = await availability(t, name);
        expect(result.status, name).toBe("review");
        expect(result.reviewReasons?.[0]).toMatch(/^confusable:/);
      }
      expect((await availability(t, "google")).status).toBe("reserved");
      expect((await availability(t, "ctbc")).status).toBe("reserved");
      expect((await availability(t, "www")).status).toBe("reserved");
    });

    it("rejects invalid labels, punycode and reserves 1–2 character names", async () => {
      expect((await availability(t, "xn--fiqs8s")).status).toBe("invalid");
      expect((await availability(t, "a--b")).status).toBe("invalid");
      expect((await availability(t, "-abc")).status).toBe("invalid");
      expect((await availability(t, "has_underscore")).status).toBe("invalid");
      expect((await availability(t, "x".repeat(33))).status).toBe("invalid");
      expect((await availability(t, "ab")).status).toBe("reserved");
      const fullWidth = await availability(t, "ＡＢＣＤ");
      expect(fullWidth).toMatchObject({ name: "abcd", status: "available" });
      const fixed = await availability(t, "my_site");
      expect(fixed.suggestions).toContain("my-site");
    });

    it("sends new GitHub accounts to review and respects the review mode setting", async () => {
      const young = await login(t, "young-user", { githubAgeDays: 5 });
      const result = await availability(t, "young-site", young);
      expect(result).toMatchObject({ status: "review", reviewReasons: ["account_too_new"] });
      await setSetting(t.deps.db, "review_mode", "all");
      expect((await availability(t, "plain-name")).reviewReasons).toEqual(["review_all"]);
      await setSetting(t.deps.db, "review_mode", "none");
      expect((await availability(t, "young-site", young)).status).toBe("available");
      expect((await availability(t, "g00gle")).status).toBe("available");
      await setSetting(t.deps.db, "review_mode", "risk");
    });

    it("reports taken and cooldown with suggestions", async () => {
      const cookie = await login(t, "taken-owner");
      await claim(t, cookie, "taken-name");
      const taken = await availability(t, "taken-name", cookie);
      expect(taken.status).toBe("taken");
      expect(taken.suggestions.length).toBeGreaterThan(0);
      expect(taken.suggestions).not.toContain("taken-name");
      await request(t, "POST", "/api/v1/subdomains/taken-name/release", {
        cookie,
        body: { confirm: "taken-name" },
      });
      await t.worker.drain();
      const cooldown = await availability(t, "taken-name");
      expect(cooldown.status).toBe("cooldown");
      const claimAgain = await request(t, "POST", "/api/v1/subdomains", {
        cookie,
        body: { name: "taken-name", acceptTerms: true, turnstileToken: "pass" },
      });
      expect(claimAgain.status).toBe(409);
      expect(await claimAgain.json()).toMatchObject({ code: "NAME_COOLDOWN" });
      t.clock.advance(31 * 86_400_000);
      expect((await availability(t, "taken-name")).status).toBe("available");
    });

    it("blocks names that already exist in the zone (imported as reserved)", async () => {
      await t.deps.sql`insert into reserved_names (name, category) values ('jason', 'zone')`;
      expect((await availability(t, "jason")).status).toBe("reserved");
    });
  });

  describe("claiming", () => {
    it("enforces the per-user subdomain quota (2) and per-user overrides", async () => {
      const cookie = await login(t, "quota-user");
      await claim(t, cookie, "quota-one");
      await claim(t, cookie, "quota-two");
      const third = await request(t, "POST", "/api/v1/subdomains", {
        cookie,
        body: { name: "quota-three", acceptTerms: true, turnstileToken: "pass" },
      });
      expect(third.status).toBe(409);
      expect(await third.json()).toMatchObject({ code: "SUBDOMAIN_QUOTA_EXCEEDED" });
      await t.deps.sql`update users set quota_subdomains = 3 where github_login = 'quota-user'`;
      await claim(t, cookie, "quota-three");
    });

    it("requires Turnstile, accepted terms and an open registration", async () => {
      const cookie = await login(t, "claim-checks");
      const noTurnstile = await request(t, "POST", "/api/v1/subdomains", {
        cookie,
        body: { name: "claim-checks", acceptTerms: true, turnstileToken: "bad" },
      });
      expect(await noTurnstile.json()).toMatchObject({ code: "TURNSTILE_FAILED" });
      await setSetting(t.deps.db, "registration_open", false);
      const closed = await request(t, "POST", "/api/v1/subdomains", {
        cookie,
        body: { name: "claim-checks", acceptTerms: true, turnstileToken: "pass" },
      });
      expect(await closed.json()).toMatchObject({ code: "REGISTRATION_CLOSED" });
      await setSetting(t.deps.db, "registration_open", true);
    });

    it("routes risky names to pending_review and notifies admins", async () => {
      const cookie = await login(t, "risky-user");
      const sub = await claim(t, cookie, "paypa1-shop");
      expect(sub.status).toBe("pending_review");
      expect(t.notifier.sent.some((a) => a.title === "新的待審子網域")).toBe(true);
      const record = await request(t, "POST", "/api/v1/subdomains/paypa1-shop/records", {
        cookie,
        body: { type: "A", name: "@", ttl: 1, address: "1.1.1.1" },
      });
      expect(await record.json()).toMatchObject({ code: "SUBDOMAIN_NOT_ACTIVE" });
    });

    it("closes availability and claiming when the zone capacity gate is reached", async () => {
      await setSetting(t.deps.db, "zone_snapshot", {
        recordCount: 980,
        unmanagedCount: 980,
        plan: "free",
        at: new Date().toISOString(),
      });
      expect((await availability(t, "late-comer")).status).toBe("capacity_full");
      const cookie = await login(t, "late-comer");
      const res = await request(t, "POST", "/api/v1/subdomains", {
        cookie,
        body: { name: "late-comer", acceptTerms: true, turnstileToken: "pass" },
      });
      expect(await res.json()).toMatchObject({ code: "ZONE_CAPACITY_EXHAUSTED" });
      const meta = await (await request(t, "GET", "/api/v1/meta")).json();
      expect(meta).toMatchObject({ zoneNearlyFull: true });
      await setSetting(t.deps.db, "zone_snapshot", null);
    });
  });

  describe("records", () => {
    let alice: string;
    let bob: string;
    const post = (cookie: string, sub: string, body: unknown) =>
      request(t, "POST", `/api/v1/subdomains/${sub}/records`, { cookie, body });
    beforeAll(async () => {
      alice = await login(t, "rec-alice");
      bob = await login(t, "rec-bob");
      await claim(t, alice, "rec-alice");
      await claim(t, alice, "rec-alice2");
      await claim(t, bob, "rec-bob");
    });
    // 每分鐘 10 次的紀錄寫入限流：每個測試前讓 bucket 補滿
    beforeEach(() => t.clock.advance(61_000));

    it.each([
      ["127.0.0.1"],
      ["10.1.2.3"],
      ["172.16.0.1"],
      ["192.168.1.1"],
      ["169.254.169.254"],
      ["100.64.0.1"],
      ["0.0.0.0"],
      ["224.0.0.1"],
      ["255.255.255.255"],
    ])("rejects non-public IPv4 %s", async (address) => {
      const res = await post(alice, "rec-alice", { type: "A", name: "ip", ttl: 1, address });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "IP_NOT_PUBLIC" });
    });

    it.each([["::1"], ["fe80::1"], ["fc00::1"], ["2001:db8::1"], ["::ffff:10.0.0.1"], ["ff02::1"]])(
      "rejects non-public IPv6 %s",
      async (address) => {
        const res = await post(alice, "rec-alice", { type: "AAAA", name: "ip6", ttl: 1, address });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: "IP_NOT_PUBLIC" });
      },
    );

    it("enforces CNAME exclusivity both ways", async () => {
      expect(
        (await post(alice, "rec-alice", { type: "A", name: "www", ttl: 1, address: "1.1.1.1" }))
          .status,
      ).toBe(202);
      const cname = await post(alice, "rec-alice", {
        type: "CNAME",
        name: "www",
        ttl: 1,
        target: "alice.github.io",
      });
      expect(await cname.json()).toMatchObject({ code: "RECORD_CONFLICT" });
      expect(
        (
          await post(alice, "rec-alice", {
            type: "CNAME",
            name: "blog",
            ttl: 1,
            target: "alice.github.io",
          })
        ).status,
      ).toBe(202);
      const txt = await post(alice, "rec-alice", { type: "TXT", name: "blog", ttl: 1, value: "x" });
      expect(await txt.json()).toMatchObject({ code: "RECORD_CONFLICT" });
    });

    it("rejects duplicates and normalizes input (case, trailing dot)", async () => {
      const first = await post(alice, "rec-alice", {
        type: "CNAME",
        name: "Docs",
        ttl: 1,
        target: "Alice.GitHub.io.",
      });
      expect(first.status, await first.clone().text()).toBe(202);
      const dup = await post(alice, "rec-alice", {
        type: "CNAME",
        name: "docs",
        ttl: 1,
        target: "alice.github.io",
      });
      expect(await dup.json()).toMatchObject({ code: "RECORD_DUPLICATE" });
      const second = await post(alice, "rec-alice", {
        type: "CNAME",
        name: "docs",
        ttl: 1,
        target: "other.example.com",
      });
      expect(await second.json()).toMatchObject({ code: "RECORD_CONFLICT" });
      const list = (await (
        await request(t, "GET", "/api/v1/subdomains/rec-alice/records", { cookie: alice })
      ).json()) as {
        items: { name: string; target?: string }[];
      };
      expect(list.items.find((r) => r.name === "docs")?.target).toBe("alice.github.io");
      expect(
        (await post(alice, "rec-alice", { type: "TXT", name: "dup", ttl: 1, value: "same" }))
          .status,
      ).toBe(202);
      const again = await post(alice, "rec-alice", {
        type: "TXT",
        name: "dup",
        ttl: 1,
        value: "same",
      });
      expect(await again.json()).toMatchObject({ code: "RECORD_DUPLICATE" });
    });

    it("only lets a CNAME point at dev-in.tw names the user owns", async () => {
      expect(
        (
          await post(alice, "rec-alice", {
            type: "CNAME",
            name: "mine",
            ttl: 1,
            target: "rec-alice2.dev-in.tw",
          })
        ).status,
      ).toBe(202);
      const cross = await post(alice, "rec-alice", {
        type: "CNAME",
        name: "theirs",
        ttl: 1,
        target: "rec-bob.dev-in.tw",
      });
      expect(await cross.json()).toMatchObject({ code: "RECORD_TARGET_NOT_ALLOWED" });
      const apex = await post(alice, "rec-alice", {
        type: "CNAME",
        name: "apex",
        ttl: 1,
        target: "dev-in.tw",
      });
      expect(await apex.json()).toMatchObject({ code: "RECORD_TARGET_NOT_ALLOWED" });
      const self = await post(alice, "rec-alice", {
        type: "CNAME",
        name: "@",
        ttl: 1,
        target: "rec-alice.dev-in.tw",
      });
      expect(await self.json()).toMatchObject({ code: "RECORD_TARGET_NOT_ALLOWED" });
    });

    it("rejects disallowed types, bad TTLs and invalid SRV names", async () => {
      const ns = await post(alice, "rec-alice", {
        type: "NS",
        name: "x",
        ttl: 1,
        target: "ns1.example.com",
      });
      expect(ns.status).toBe(400);
      const ttl = await post(alice, "rec-alice", { type: "TXT", name: "ttl", ttl: 30, value: "x" });
      expect(await ttl.json()).toMatchObject({ code: "VALIDATION_FAILED" });
      const srv = await post(alice, "rec-alice", {
        type: "SRV",
        name: "_minecraft._icmp",
        ttl: 1,
        priority: 0,
        weight: 5,
        port: 25565,
        target: "mc.example.net",
      });
      expect(srv.status).toBe(400);
      expect(
        (
          await post(alice, "rec-alice", {
            type: "SRV",
            name: "_minecraft._tcp",
            ttl: 1,
            priority: 0,
            weight: 5,
            port: 25565,
            target: "mc.example.net",
          })
        ).status,
      ).toBe(202);
      expect(
        (
          await post(alice, "rec-alice", {
            type: "CAA",
            name: "@",
            ttl: 1,
            flags: 0,
            tag: "issue",
            value: "letsencrypt.org",
          })
        ).status,
      ).toBe(202);
    });

    it("enforces the per-subdomain record quota (10)", async () => {
      const cookie = await login(t, "rec-quota");
      await claim(t, cookie, "rec-quota");
      for (let i = 0; i < 10; i++) {
        expect(
          (await post(cookie, "rec-quota", { type: "TXT", name: `q${i}`, ttl: 1, value: "x" }))
            .status,
        ).toBe(202);
        if (i === 8) t.clock.advance(60_000);
      }
      t.clock.advance(60_000);
      const over = await post(cookie, "rec-quota", {
        type: "TXT",
        name: "q10",
        ttl: 1,
        value: "x",
      });
      expect(over.status).toBe(409);
      expect(await over.json()).toMatchObject({ code: "RECORD_QUOTA_EXCEEDED" });
      const list = (await (
        await request(t, "GET", "/api/v1/subdomains/rec-quota/records", { cookie })
      ).json()) as { usage: unknown };
      expect(list.usage).toEqual({ used: 10, limit: 10 });
    });

    it("refuses new records when the zone is full", async () => {
      await setSetting(t.deps.db, "zone_snapshot", {
        recordCount: 979,
        unmanagedCount: 979,
        plan: "free",
        at: new Date().toISOString(),
      });
      const res = await post(bob, "rec-bob", { type: "TXT", name: "full", ttl: 1, value: "x" });
      expect(await res.json()).toMatchObject({ code: "ZONE_CAPACITY_EXHAUSTED" });
      await setSetting(t.deps.db, "zone_snapshot", null);
    });
  });

  describe("presets", () => {
    it("plans with a diff and validates parameters", async () => {
      const cookie = await login(t, "preset-user");
      await claim(t, cookie, "preset-user");
      await request(t, "POST", "/api/v1/subdomains/preset-user/records", {
        cookie,
        body: { type: "A", name: "@", ttl: 1, address: "1.2.3.4" },
      });
      const plan = await request(t, "POST", "/api/v1/subdomains/preset-user/presets/vercel/plan", {
        cookie,
        body: { params: {} },
      });
      const body = (await plan.json()) as {
        creates: unknown[];
        deletes: { type: string }[];
        warnings: string[];
      };
      expect(body.creates).toEqual([
        { type: "CNAME", name: "@", ttl: 1, target: "cname.vercel-dns.com" },
      ]);
      expect(body.deletes.map((d) => d.type)).toEqual(["A"]);
      expect(body.warnings.length).toBeGreaterThan(0);
      const invalid = await request(
        t,
        "POST",
        "/api/v1/subdomains/preset-user/presets/netlify/plan",
        { cookie, body: { params: {} } },
      );
      expect(await invalid.json()).toMatchObject({ code: "PRESET_PARAMS_INVALID" });
      const crossUser = await request(
        t,
        "POST",
        "/api/v1/subdomains/preset-user/presets/zeabur/plan",
        {
          cookie,
          body: { params: { target: "someone-else.dev-in.tw" } },
        },
      );
      expect(await crossUser.json()).toMatchObject({ code: "PRESET_PARAMS_INVALID" });
      const presets = (await (await request(t, "GET", "/api/v1/presets")).json()) as {
        items: { available: boolean }[];
      };
      expect(presets.items.every((p) => p.available)).toBe(true);
    });

    it("applies atomically: deletes conflicting records first, then creates", async () => {
      const cookie = await login(t, "preset-apply");
      await claim(t, cookie, "preset-apply");
      await request(t, "POST", "/api/v1/subdomains/preset-apply/records", {
        cookie,
        body: { type: "A", name: "@", ttl: 1, address: "1.2.3.4" },
      });
      await t.worker.drain();
      const res = await request(
        t,
        "POST",
        "/api/v1/subdomains/preset-apply/presets/improvmx/apply",
        { cookie, body: { params: {} } },
      );
      expect(res.status).toBe(202);
      await t.worker.drain();
      const list = (await (
        await request(t, "GET", "/api/v1/subdomains/preset-apply/records", { cookie })
      ).json()) as {
        items: { type: string; syncStatus: string }[];
      };
      expect(list.items.map((r) => r.type).sort()).toEqual(["A", "MX", "MX", "TXT"]);
      expect(list.items.every((r) => r.syncStatus === "synced")).toBe(true);
      const gh = await request(
        t,
        "POST",
        "/api/v1/subdomains/preset-apply/presets/github-pages/apply",
        { cookie, body: { params: {} } },
      );
      expect(gh.status).toBe(202);
      await t.worker.drain();
      const after = (await (
        await request(t, "GET", "/api/v1/subdomains/preset-apply/records", { cookie })
      ).json()) as {
        items: { type: string; name: string; target?: string }[];
      };
      expect(after.items.filter((r) => r.name === "@").map((r) => r.type)).toEqual(["CNAME"]);
      expect(after.items.find((r) => r.type === "CNAME")?.target).toBe("preset-apply.github.io");
      const fqdns = [...t.provider.records.values()]
        .filter((r) => r.fqdn === "preset-apply.dev-in.tw")
        .map((r) => r.type);
      expect(fqdns).toEqual(["CNAME"]);
    });
  });
});
