import { describe, expect, it } from "vitest";
import { classifyLazcoError } from "../src/adapters/lazco-dns/errors.ts";
import { firstChunk, LazcoDnsProvider } from "../src/adapters/lazco-dns/provider.ts";
import {
  canonicalValue,
  fromLazco,
  idOf,
  normalizeTtl,
  parseId,
  toLazcoValue,
} from "../src/adapters/lazco-dns/values.ts";
import { batchSchedule } from "../src/sync/change-budget.ts";
import { encodeTxt, sameRecord, toProviderInput } from "../src/sync/mapper.ts";
import type { ChangeBudget, ProviderRecordInput } from "../src/sync/provider-port.ts";
import { FakeLazcoDns } from "./helpers/fake-lazco.ts";

class MemoryBudget implements ChangeBudget {
  used = 0;
  last: Date | null = null;
  readonly dailyBudget: number;
  constructor(dailyBudget = 80) {
    this.dailyBudget = dailyBudget;
  }
  async take(now: Date) {
    if (this.used >= this.dailyBudget) return false;
    this.used++;
    this.last = now;
    return true;
  }
  async exhaust() {
    this.used = this.dailyBudget;
  }
  async state() {
    return { usedToday: this.used, lastBatchAt: this.last };
  }
}

const NOW = new Date("2026-10-14T09:00:00.000Z");

function setup(opts: { budget?: number } = {}) {
  const fake = new FakeLazcoDns({ now: () => NOW });
  const budget = new MemoryBudget(opts.budget ?? 80);
  const sleeps: number[] = [];
  const provider = new LazcoDnsProvider({
    token: fake.token,
    zoneId: fake.zoneId,
    apiUrl: "https://api.lazco.test/",
    budget,
    protectedFqdns: ["dev-in.tw", "www.dev-in.tw"],
    fetch: fake.fetch,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { fake, budget, provider, sleeps };
}

const input = (over: Partial<ProviderRecordInput> & Pick<ProviderRecordInput, "type">) =>
  ({ fqdn: "alice.dev-in.tw", ttl: 1, comment: "dit:x", ...over }) as ProviderRecordInput;

describe("lazco values", () => {
  it("normalizes the auto TTL and clamps to the Lazco range", () => {
    expect(normalizeTtl(1)).toBe(300);
    expect(normalizeTtl(60)).toBe(60);
    expect(normalizeTtl(86_400)).toBe(86_400);
  });

  it("gives the same id whichever way the provider prints a value", () => {
    expect(idOf("Alice.dev-in.tw.", "AAAA", "2001:DB8:0:0:0:0:0:1")).toBe(
      idOf("alice.dev-in.tw", "AAAA", "2001:db8::1"),
    );
    expect(idOf("alice.dev-in.tw", "CNAME", "Alice.GitHub.io.")).toBe(
      idOf("alice.dev-in.tw", "CNAME", "alice.github.io"),
    );
    const long = "v".repeat(400);
    expect(canonicalValue("TXT", encodeTxt(long))).toBe(long);
    expect(canonicalValue("TXT", `"${long.slice(0, 255)}" "${long.slice(255)}"`)).toBe(long);
    expect(canonicalValue("MX", "10   MX1.example.com.")).toBe("10 mx1.example.com");
    expect(canonicalValue("CAA", '0 ISSUE "letsencrypt.org"')).toBe("0 issue letsencrypt.org");
    const id = idOf("a.dev-in.tw", "TXT", '"x|y"');
    expect(parseId(id)).toEqual({ fqdn: "a.dev-in.tw", type: "TXT", canonical: "x|y" });
    expect(parseId("nope")).toBeNull();
  });

  it("round-trips every Dev-in record type through the fake Lazco normalization", async () => {
    const records = [
      { type: "A", data: { address: "203.0.114.1" } },
      { type: "AAAA", data: { address: "2001:0db8:0000:0000:0000:0000:0000:0001" } },
      { type: "CNAME", data: { target: "alice.github.io" } },
      { type: "TXT", data: { value: "v=spf1 include:_spf.example.com ~all" } },
      { type: "MX", data: { priority: 10, exchange: "mx1.improvmx.com" } },
      { type: "SRV", data: { priority: 0, weight: 5, port: 25565, target: "mc.example.net" } },
      { type: "CAA", data: { flags: 0, tag: "issue", value: "letsencrypt.org" } },
    ] as const;
    const { fake, provider } = setup();
    for (const [i, r] of records.entries()) {
      const desired = toProviderInput(
        {
          id: `0199e2a1-7c00-7a00-8000-00000000000${i}`,
          name: `n${i}`,
          type: r.type,
          ttl: 1,
          data: r.data,
        },
        "alice",
        "dev-in.tw",
      );
      await provider.create(desired);
      const stored = fake.get(desired.fqdn, desired.type);
      expect(stored, r.type).toBeDefined();
      const actual = fromLazco(
        {
          fqdn: desired.fqdn,
          type: desired.type,
          ttl: stored?.ttl ?? 0,
          values: stored?.values ?? [],
        },
        stored?.values[0] ?? "",
      );
      expect(actual.id, r.type).toBe(idOf(desired.fqdn, desired.type, toLazcoValue(desired)));
      expect(sameRecord({ ...desired, ttl: 300 }, actual), r.type).toBe(true);
    }
  });

  it("keeps every change of one name in the same chunk", () => {
    const changes = [
      { action: "DELETE" as const, fqdn: "a.dev-in.tw", type: "A", expected: ["1.1.1.1"] },
      ...Array.from({ length: 3 }, (_, i) => ({
        action: "REPLACE" as const,
        fqdn: `b${i}.dev-in.tw`,
        type: "A",
        ttl: 300,
        values: ["1.1.1.1"],
      })),
      {
        action: "REPLACE" as const,
        fqdn: "a.dev-in.tw",
        type: "CNAME",
        ttl: 300,
        values: ["x.example."],
      },
    ];
    const chunk = firstChunk(changes, 2);
    expect(chunk.map((c) => `${c.fqdn} ${c.type}`)).toEqual(["a.dev-in.tw A", "a.dev-in.tw CNAME"]);
  });
});

describe("LazcoDnsProvider", () => {
  it("reads the zone without the managed apex NS and checks the zone name", async () => {
    const { fake, provider } = setup();
    fake.seed("www.dev-in.tw", "A", ["203.0.114.10"]);
    const zone = await provider.readZone();
    expect(zone.rrsets.map((r) => `${r.fqdn} ${r.type}`)).toEqual(["www.dev-in.tw A"]);
    expect(await provider.zoneInfo()).toEqual({
      name: "dev-in.tw",
      plan: "lazco",
      recordCount: 1,
      capacity: 500,
    });
    const listed = [];
    for await (const r of provider.listAll()) listed.push(r);
    expect(listed).toEqual([
      expect.objectContaining({ fqdn: "www.dev-in.tw", content: "203.0.114.10", comment: null }),
    ]);
    expect(await provider.findByComment("dit:anything")).toBeNull();
  });

  it("merges values into the RRset, sends If-Match and spends one batch per PATCH", async () => {
    const { fake, provider, budget } = setup();
    fake.seed("alice.dev-in.tw", "A", ["203.0.114.1"], 3600);
    const created = await provider.create(input({ type: "A", content: "203.0.114.2", ttl: 300 }));
    expect(created.id).toBe("alice.dev-in.tw|A|203.0.114.2");
    expect(fake.get("alice.dev-in.tw", "A")).toEqual({
      name: "alice.dev-in.tw.",
      type: "A",
      ttl: 300,
      values: ["203.0.114.1", "203.0.114.2"],
    });
    const patch = fake.calls.find((c) => c.method === "PATCH");
    expect(patch?.ifMatch).toMatch(/^"\d+"$/);
    expect(budget.used).toBe(1);

    await provider.delete("alice.dev-in.tw|A|203.0.114.1");
    expect(fake.get("alice.dev-in.tw", "A")?.values).toEqual(["203.0.114.2"]);
    await provider.delete("alice.dev-in.tw|A|203.0.114.2");
    expect(fake.get("alice.dev-in.tw", "A")).toBeUndefined();
    // 已經不在的值：不送 PATCH，也不扣額度
    await provider.delete("alice.dev-in.tw|A|203.0.114.2");
    expect(budget.used).toBe(3);
    expect(fake.patches).toBe(3);
  });

  it("re-reads and re-plans on 412, 409 and an unknown outcome without applying twice", async () => {
    const { fake, provider, sleeps } = setup();
    fake.fail({ kind: "concurrent", apply: (f) => f.seed("other.dev-in.tw", "TXT", ["manual"]) });
    await provider.create(input({ type: "A", content: "203.0.114.1" }));
    expect(fake.get("alice.dev-in.tw", "A")?.values).toEqual(["203.0.114.1"]);
    expect(fake.get("other.dev-in.tw", "TXT")).toBeDefined();

    fake.fail({ kind: "in_progress" });
    await provider.create(input({ type: "A", content: "203.0.114.2" }));
    expect(sleeps).toEqual([2000]);

    fake.fail({ kind: "outcome_unknown" });
    const before = fake.patches;
    await provider.create(input({ type: "A", content: "203.0.114.3" }));
    // 第一次其實已經生效，重新讀取後 plan 變成空的，不會再送
    expect(fake.patches - before).toBe(1);
    expect(fake.get("alice.dev-in.tw", "A")?.values).toHaveLength(3);
  });

  it("treats 202 pending as written", async () => {
    const { fake, provider } = setup();
    fake.fail({ kind: "pending" });
    await provider.create(input({ type: "TXT", content: encodeTxt("hello") }));
    expect(fake.get("alice.dev-in.tw", "TXT")?.values).toEqual(['"hello"']);
  });

  it("refuses system names and stops when the daily budget is spent", async () => {
    const { fake, provider } = setup({ budget: 1 });
    await expect(
      provider.create(input({ fqdn: "www.dev-in.tw", type: "A", content: "203.0.114.1" })),
    ).rejects.toMatchObject({
      providerCode: "lazco:protected_name",
    });
    await provider.create(input({ type: "A", content: "203.0.114.1" }));
    const err = await provider.create(input({ type: "A", content: "203.0.114.2" })).catch((e) => e);
    expect(err).toMatchObject({ kind: "capacity", providerCode: "budget:exhausted" });
    expect(err.retryAt.toISOString()).toBe("2026-10-15T00:01:00.000Z");
    expect(fake.patches).toBe(1);
  });

  it("classifies the Lazco Cloud error envelope by code", async () => {
    const { fake, provider } = setup();
    fake.setUsedToday(90);
    expect(
      await provider.create(input({ type: "A", content: "203.0.114.1" })).catch((e) => e),
    ).toMatchObject({
      kind: "capacity",
      providerCode: "lazco:DNS_DAILY_CHANGE_LIMIT",
      retryAt: new Date("2026-10-15T00:01:00.000Z"),
    });
    fake.setUsedToday(0);
    fake.fail({ kind: "rate_limited", retryAfter: 1200 });
    expect(
      await provider.create(input({ type: "A", content: "203.0.114.1" })).catch((e) => e),
    ).toMatchObject({
      kind: "transient",
      providerCode: "lazco:RATE_LIMITED",
      retryAt: new Date(NOW.getTime() + 1_200_000),
    });
    fake.rejectValues.add("203.0.114.66");
    const invalid = await provider
      .create(input({ type: "A", content: "203.0.114.66" }))
      .catch((e) => e);
    expect(invalid).toMatchObject({ kind: "permanent", providerCode: "lazco:DNS_VALUE_INVALID" });
    expect(invalid.issues).toEqual([
      expect.objectContaining({ key: "alice.dev-in.tw|A", code: "DNS_VALUE_INVALID" }),
    ]);
    fake.forbidden = true;
    expect(await provider.zoneInfo().catch((e) => e)).toMatchObject({ kind: "auth" });
    fake.forbidden = false;
    const wrong = new LazcoDnsProvider({
      token: "lz_live_wrong",
      zoneId: fake.zoneId,
      apiUrl: "https://api.lazco.test",
      budget: new MemoryBudget(),
      fetch: fake.fetch,
    });
    expect(await wrong.zoneInfo().catch((e) => e)).toMatchObject({
      kind: "auth",
      providerCode: "lazco:UNAUTHORIZED",
    });
    fake.fail({ kind: "unavailable" });
    expect(
      await provider.create(input({ type: "A", content: "203.0.114.9" })).catch((e) => e),
    ).toMatchObject({
      kind: "transient",
    });

    const at = new Date("2026-10-14T12:00:00Z");
    expect(classifyLazcoError(404, { code: "NOT_FOUND" }, null, at).kind).toBe("not_found");
    expect(classifyLazcoError(403, { code: "DNS_ZONE_SUSPENDED" }, null, at).kind).toBe("auth");
    expect(classifyLazcoError(409, { code: "DNS_ZONE_NOT_WRITABLE" }, null, at).kind).toBe(
      "transient",
    );
    expect(
      classifyLazcoError(
        422,
        {
          code: "DNS_RRSET_LIMIT_REACHED",
          issues: [{ index: -1, code: "DNS_RRSET_LIMIT_REACHED", message: "" }],
        },
        null,
        at,
      ).kind,
    ).toBe("capacity");
    expect(classifyLazcoError(422, { code: "DNS_CNAME_CONFLICT" }, null, at).message).toContain(
      "衝突",
    );
    expect(classifyLazcoError(504, { code: "DNS_OUTCOME_UNKNOWN" }, null, at).providerCode).toBe(
      "lazco:DNS_OUTCOME_UNKNOWN",
    );
    expect(classifyLazcoError(502, null, null, at)).toMatchObject({
      kind: "transient",
      providerCode: "http:502",
    });
  });
});

describe("batchSchedule", () => {
  const day = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 14, h, m));
  it("spreads the remaining budget over the rest of the UTC day", () => {
    const s = batchSchedule(day(0), { usedToday: 0, lastBatchAt: day(0) }, 80, 60_000);
    expect(s.intervalMs).toBe(18 * 60_000);
    expect(s.nextAt).toEqual(day(0, 18));
    expect(s.pausedUntil).toBeNull();
    // 前半天沒用：後半天間隔變短
    const late = batchSchedule(day(12), { usedToday: 0, lastBatchAt: null }, 80, 60_000);
    expect(late.intervalMs).toBe(9 * 60_000);
    expect(late.nextAt).toEqual(day(12));
    // 不會比最短間隔更頻繁
    expect(
      batchSchedule(day(23, 50), { usedToday: 0, lastBatchAt: null }, 80, 60_000).intervalMs,
    ).toBe(60_000);
  });

  it("with no daily budget, waits only the minimum interval and never pauses", () => {
    const s = batchSchedule(day(0), { usedToday: 500, lastBatchAt: day(0) }, 0, 40_000);
    expect(s.intervalMs).toBe(40_000);
    expect(s.nextAt).toEqual(new Date(day(0).getTime() + 40_000));
    expect(s.pausedUntil).toBeNull();
    const idle = batchSchedule(day(23, 59), { usedToday: 5000, lastBatchAt: day(1) }, 0, 40_000);
    expect(idle.nextAt).toEqual(day(23, 59));
    expect(idle.pausedUntil).toBeNull();
  });

  it("pauses until just after the next UTC midnight when the budget is spent", () => {
    const s = batchSchedule(day(20), { usedToday: 80, lastBatchAt: day(19) }, 80, 60_000);
    expect(s.pausedUntil?.toISOString()).toBe("2026-10-15T00:01:00.000Z");
    expect(s.nextAt).toEqual(s.pausedUntil);
  });
});
