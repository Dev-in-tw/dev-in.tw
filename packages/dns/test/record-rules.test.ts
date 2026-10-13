import type { RecordInput } from "@dit/contract";
import { records as fixtureRecords } from "@dit/contract/fixtures";
import { describe, expect, it } from "vitest";
import {
  describeRecord,
  findConflicts,
  isValidTtl,
  MAX_TXT_PER_NAME,
  recordContent,
  recordDataEquals,
  subdomainOf,
  toFqdn,
  validateRecord,
} from "../src/index.ts";
import { codesOf, ctx, MVP_TYPES, rec } from "./helpers.ts";

const a = (address: string, name = "@"): RecordInput => ({ type: "A", name, ttl: 1, address });
const aaaa = (address: string, name = "@"): RecordInput => ({
  type: "AAAA",
  name,
  ttl: 1,
  address,
});
const cname = (target: string, name = "www"): RecordInput => ({
  type: "CNAME",
  name,
  ttl: 300,
  target,
});
const txt = (value: string, name = "@"): RecordInput => ({ type: "TXT", name, ttl: 300, value });
const mx = (exchange: string, priority = 10, name = "@"): RecordInput => ({
  type: "MX",
  name,
  ttl: 3600,
  priority,
  exchange,
});
const srv = (
  name: string,
  over: Partial<{ priority: number; weight: number; port: number; target: string }> = {},
): RecordInput => ({
  type: "SRV",
  name,
  ttl: 300,
  priority: 0,
  weight: 5,
  port: 25565,
  target: "mc.example.net",
  ...over,
});
const caa = (
  tag: "issue" | "issuewild" | "iodef",
  value: string,
  flags: 0 | 128 = 0,
): RecordInput => ({
  type: "CAA",
  name: "@",
  ttl: 3600,
  flags,
  tag,
  value,
});

describe("toFqdn / subdomainOf / isValidTtl", () => {
  it("builds FQDNs", () => {
    expect(toFqdn("@", "alice", "dev-in.tw")).toBe("alice.dev-in.tw");
    expect(toFqdn("_dmarc", "alice", "dev-in.tw")).toBe("_dmarc.alice.dev-in.tw");
  });

  it.each([
    ["dev-in.tw", ""],
    ["alice.dev-in.tw", "alice"],
    ["www.alice.dev-in.tw", "alice"],
    ["a.b.bob.dev-in.tw", "bob"],
    ["evildev-in.tw", null],
    ["example.com", null],
  ])("subdomainOf(%s) → %j", (host, owner) => {
    expect(subdomainOf(host, "dev-in.tw")).toBe(owner);
  });

  it.each([
    [1, true],
    [60, true],
    [86_400, true],
    [0, false],
    [2, false],
    [59, false],
    [86_401, false],
    [300.5, false],
  ])("ttl %d → %s", (ttl, ok) => {
    expect(isValidTtl(ttl)).toBe(ok);
  });
});

describe("validateRecord: common rules", () => {
  it("accepts every contract fixture record shape (with an empty zone)", () => {
    for (const r of Object.values(fixtureRecords)) {
      expect(validateRecord(r, ctx())).toEqual({ ok: true });
    }
  });

  it("rejects types outside the allowlist and stops there", () => {
    const v = validateRecord(srv("_minecraft._tcp"), ctx({ allowedTypes: MVP_TYPES }));
    expect(codesOf(v)).toEqual(["RECORD_TYPE_NOT_ALLOWED"]);
    if (!v.ok) expect(v.violations[0]?.path).toBe("type");
    const ns = { type: "NS", name: "@", ttl: 1, target: "ns1.evil.com" } as unknown as RecordInput;
    expect(codesOf(validateRecord(ns, ctx()))).toEqual(["RECORD_TYPE_NOT_ALLOWED"]);
  });

  it.each(["*", "*.www", "WWW", "a.b.c.d", "-www", "www-", "a..b", "", "_", "www."])(
    "rejects record name %j",
    (name) => {
      const v = validateRecord(a("1.1.1.1", name), ctx());
      expect(codesOf(v)).toContain("VALIDATION_FAILED");
      if (!v.ok) expect(v.violations.map((x) => x.path)).toContain("name");
    },
  );

  it.each([
    "@",
    "www",
    "_acme-challenge",
    "_minecraft._tcp",
    "a.b.c",
    "_github-pages-challenge-alice",
  ])("accepts record name %s", (name) => {
    expect(validateRecord(txt("hello", name), ctx())).toEqual({ ok: true });
  });

  it("rejects an FQDN longer than 253 characters", () => {
    const label = "a".repeat(63);
    const name = `${label}.${label}.${label}`;
    const longRoot = `${"b".repeat(60)}.tw`;
    const v = validateRecord(txt("x", name), ctx({ root: longRoot }));
    expect(codesOf(v)).toEqual(["VALIDATION_FAILED"]);
    expect(validateRecord(txt("x", name), ctx())).toEqual({ ok: true });
  });

  it.each([0, 30, 86_401, 1.5])("rejects ttl %d", (ttl) => {
    const v = validateRecord({ ...a("1.1.1.1"), ttl } as RecordInput, ctx());
    expect(codesOf(v)).toEqual(["VALIDATION_FAILED"]);
    if (!v.ok) expect(v.violations[0]?.path).toBe("ttl");
  });
});

describe("validateRecord: A / AAAA", () => {
  it.each(["10.0.0.1", "127.0.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"])(
    "rejects non-public IPv4 %s",
    (ip) => {
      const v = validateRecord(a(ip), ctx());
      expect(codesOf(v)).toEqual(["IP_NOT_PUBLIC"]);
      if (!v.ok) {
        expect(v.violations[0]?.path).toBe("address");
        expect(v.violations[0]?.message).toContain("外部無法連線");
      }
    },
  );

  it("rejects malformed IPv4 as a validation error", () => {
    expect(codesOf(validateRecord(a("1.2.3.256"), ctx()))).toEqual(["VALIDATION_FAILED"]);
  });

  it.each(["::1", "fe80::1", "fd00::1", "2001:db8::1", "::ffff:1.2.3.4"])(
    "rejects non-public IPv6 %s",
    (ip) => {
      expect(codesOf(validateRecord(aaaa(ip), ctx()))).toEqual(["IP_NOT_PUBLIC"]);
    },
  );

  it("rejects malformed IPv6 and accepts global unicast", () => {
    expect(codesOf(validateRecord(aaaa("2001::zz"), ctx()))).toEqual(["VALIDATION_FAILED"]);
    expect(validateRecord(aaaa("2606:4700:4700::1111"), ctx())).toEqual({ ok: true });
  });
});

describe("validateRecord: CNAME", () => {
  it("accepts external hostnames", () => {
    expect(validateRecord(cname("alice.github.io"), ctx())).toEqual({ ok: true });
    expect(validateRecord(cname("cname.vercel-dns.com", "@"), ctx())).toEqual({ ok: true });
  });

  it("rejects IP targets and malformed hostnames", () => {
    expect(codesOf(validateRecord(cname("1.2.3.4"), ctx()))).toEqual(["RECORD_TARGET_NOT_ALLOWED"]);
    expect(codesOf(validateRecord(cname("2001:db8::1"), ctx()))).toEqual([
      "RECORD_TARGET_NOT_ALLOWED",
    ]);
    expect(codesOf(validateRecord(cname("localhost"), ctx()))).toEqual(["VALIDATION_FAILED"]);
    expect(codesOf(validateRecord(cname("Example.COM"), ctx()))).toEqual(["VALIDATION_FAILED"]);
  });

  it("rejects pointing at itself", () => {
    const v = validateRecord(cname("www.alice.dev-in.tw"), ctx());
    expect(codesOf(v)).toEqual(["RECORD_TARGET_NOT_ALLOWED"]);
    if (!v.ok) expect(v.violations[0]?.message).toContain("自己");
  });

  it("rejects CNAME loops through existing aliases", () => {
    const existing = [rec(cname("www.alice.dev-in.tw", "blog")), rec(cname("example.com", "docs"))];
    const v = validateRecord(cname("blog.alice.dev-in.tw", "www"), ctx({ existing }));
    expect(codesOf(v)).toEqual(["RECORD_TARGET_NOT_ALLOWED"]);
    if (!v.ok) expect(v.violations[0]?.message).toContain("循環");
    expect(validateRecord(cname("docs.alice.dev-in.tw", "www"), ctx({ existing }))).toEqual({
      ok: true,
    });
  });

  it("allows only the user's own subdomains under the root (cross-user CNAME)", () => {
    expect(validateRecord(cname("alice.dev-in.tw"), ctx())).toEqual({ ok: true });
    expect(
      validateRecord(cname("blog.alice2.dev-in.tw"), ctx({ ownedSubdomains: ["alice", "alice2"] })),
    ).toEqual({ ok: true });
    const bob = validateRecord(cname("bob.dev-in.tw"), ctx());
    expect(codesOf(bob)).toEqual(["RECORD_TARGET_NOT_ALLOWED"]);
    if (!bob.ok) expect(bob.violations[0]?.message).toContain("自己擁有的子網域");
    expect(codesOf(validateRecord(cname("www.bob.dev-in.tw"), ctx()))).toEqual([
      "RECORD_TARGET_NOT_ALLOWED",
    ]);
    const apex = validateRecord(cname("dev-in.tw"), ctx());
    expect(codesOf(apex)).toEqual(["RECORD_TARGET_NOT_ALLOWED"]);
    if (!apex.ok) expect(apex.violations[0]?.message).toContain("本身");
    expect(validateRecord(cname("notdev-in.tw"), ctx())).toEqual({ ok: true });
  });
});

describe("validateRecord: TXT", () => {
  it("accepts printable ASCII up to 2048 characters", () => {
    expect(validateRecord(txt("v=spf1 -all"), ctx())).toEqual({ ok: true });
    expect(validateRecord(txt("x".repeat(2048)), ctx())).toEqual({ ok: true });
  });

  it.each(["", "x".repeat(2049), "中文", "line\nbreak", "tab\there"])("rejects %j", (value) => {
    const v = validateRecord(txt(value), ctx());
    expect(codesOf(v)).toEqual(["VALIDATION_FAILED"]);
    if (!v.ok) expect(v.violations[0]?.path).toBe("value");
  });

  it(`allows at most ${MAX_TXT_PER_NAME} TXT per name`, () => {
    const existing = [1, 2, 3, 4, 5].map((n) => rec(txt(`token-${n}`)));
    expect(codesOf(validateRecord(txt("token-6"), ctx({ existing })))).toEqual(["RECORD_CONFLICT"]);
    expect(validateRecord(txt("token-6"), ctx({ existing: existing.slice(1) }))).toEqual({
      ok: true,
    });
    expect(validateRecord(txt("token-6", "_other"), ctx({ existing }))).toEqual({ ok: true });
  });
});

describe("validateRecord: MX", () => {
  it("accepts a hostname exchange", () => {
    expect(validateRecord(mx("mx1.improvmx.com"), ctx())).toEqual({ ok: true });
  });

  it("rejects IP exchanges, bad priority and CNAME exchanges", () => {
    expect(codesOf(validateRecord(mx("1.2.3.4"), ctx()))).toEqual(["RECORD_TARGET_NOT_ALLOWED"]);
    expect(codesOf(validateRecord(mx("mail.example.com", 70_000), ctx()))).toEqual([
      "VALIDATION_FAILED",
    ]);
    const existing = [rec(cname("ghs.googlehosted.com", "mail"))];
    const v = validateRecord(mx("mail.alice.dev-in.tw"), ctx({ existing }));
    expect(codesOf(v)).toEqual(["RECORD_TARGET_NOT_ALLOWED"]);
    if (!v.ok) expect(v.violations[0]?.path).toBe("exchange");
    expect(codesOf(validateRecord(mx("mx.bob.dev-in.tw"), ctx()))).toEqual([
      "RECORD_TARGET_NOT_ALLOWED",
    ]);
  });
});

describe("validateRecord: SRV", () => {
  it.each(["_minecraft._tcp", "_sip._udp", "_imaps._tls", "_xmpp._tcp.chat"])(
    "accepts %s",
    (name) => {
      expect(validateRecord(srv(name), ctx())).toEqual({ ok: true });
    },
  );

  it.each(["minecraft._tcp", "_minecraft._sctp", "_minecraft", "_a._tcp._b", "www"])(
    "rejects SRV name %s",
    (name) => {
      const v = validateRecord(srv(name), ctx());
      expect(codesOf(v)).toEqual(["VALIDATION_FAILED"]);
      if (!v.ok) expect(v.violations[0]?.path).toBe("name");
    },
  );

  it("rejects bad numbers and IP targets", () => {
    expect(codesOf(validateRecord(srv("_a._tcp", { port: 0 }), ctx()))).toEqual([
      "VALIDATION_FAILED",
    ]);
    expect(
      codesOf(validateRecord(srv("_a._tcp", { weight: -1, priority: 65_536 }), ctx())),
    ).toEqual(["VALIDATION_FAILED", "VALIDATION_FAILED"]);
    expect(codesOf(validateRecord(srv("_a._tcp", { target: "1.2.3.4" }), ctx()))).toEqual([
      "RECORD_TARGET_NOT_ALLOWED",
    ]);
  });
});

describe("validateRecord: CAA", () => {
  it.each([
    caa("issue", "letsencrypt.org"),
    caa("issuewild", ";"),
    caa("iodef", "mailto:security@example.com"),
    caa("iodef", "https://example.com/caa"),
    caa("issue", "pki.goog", 128),
  ])("accepts %j", (r) => {
    expect(validateRecord(r, ctx())).toEqual({ ok: true });
  });

  it("rejects bad flags, tags and values", () => {
    expect(
      codesOf(validateRecord({ ...caa("issue", "x"), flags: 1 } as unknown as RecordInput, ctx())),
    ).toEqual(["VALIDATION_FAILED"]);
    expect(
      codesOf(
        validateRecord(
          { ...caa("issue", "x"), tag: "contactemail" } as unknown as RecordInput,
          ctx(),
        ),
      ),
    ).toEqual(["VALIDATION_FAILED"]);
    expect(codesOf(validateRecord(caa("issue", ""), ctx()))).toEqual(["VALIDATION_FAILED"]);
    expect(codesOf(validateRecord(caa("issue", "中文"), ctx()))).toEqual(["VALIDATION_FAILED"]);
    expect(codesOf(validateRecord(caa("iodef", "ftp://x"), ctx()))).toEqual(["VALIDATION_FAILED"]);
  });
});

describe("findConflicts", () => {
  it("enforces CNAME exclusivity in both directions", () => {
    const withA = [rec(a("1.1.1.1", "www"))];
    const v1 = validateRecord(cname("alice.github.io"), ctx({ existing: withA }));
    expect(codesOf(v1)).toEqual(["RECORD_CONFLICT"]);
    if (!v1.ok) expect(v1.violations[0]?.message).toContain("www.alice.dev-in.tw 已有 A");

    const withCname = [rec(cname("alice.github.io"))];
    const v2 = validateRecord(a("1.1.1.1", "www"), ctx({ existing: withCname }));
    expect(codesOf(v2)).toEqual(["RECORD_CONFLICT"]);
    if (!v2.ok) expect(v2.violations[0]?.message).toContain("www.alice.dev-in.tw 已有 CNAME");

    const v3 = validateRecord(cname("other.example.com"), ctx({ existing: withCname }));
    expect(codesOf(v3)).toEqual(["RECORD_CONFLICT"]);
    if (!v3.ok) expect(v3.violations[0]?.message).toContain("只能有一筆 CNAME");
  });

  it("ignores records on other names", () => {
    const existing = [rec(a("1.1.1.1", "@")), rec(cname("x.example.com", "blog"))];
    expect(findConflicts(cname("alice.github.io"), existing)).toEqual([]);
  });

  it("detects duplicates (name, type, data) regardless of TTL and IPv6 spelling", () => {
    const existing = [rec(aaaa("2606:4700:4700:0:0:0:0:1111")), rec(mx("mx1.improvmx.com"))];
    expect(
      codesOf(
        validateRecord(
          { ...aaaa("2606:4700:4700::1111"), ttl: 300 } as RecordInput,
          ctx({ existing }),
        ),
      ),
    ).toEqual(["RECORD_DUPLICATE"]);
    expect(codesOf(validateRecord(mx("mx1.improvmx.com"), ctx({ existing })))).toEqual([
      "RECORD_DUPLICATE",
    ]);
    expect(validateRecord(mx("mx1.improvmx.com", 20), ctx({ existing }))).toEqual({ ok: true });
    expect(validateRecord(a("1.1.1.1"), ctx({ existing: [rec(a("1.1.1.1", "www"))] }))).toEqual({
      ok: true,
    });
  });

  it("reports a duplicate CNAME as a duplicate, not a conflict", () => {
    const existing = [rec(cname("alice.github.io"))];
    expect(findConflicts(cname("alice.github.io"), existing).map((v) => v.code)).toEqual([
      "RECORD_DUPLICATE",
    ]);
  });

  it("skips conflict checks when the name itself is invalid", () => {
    const existing = [rec(cname("alice.github.io", "WWW" as string))];
    expect(codesOf(validateRecord(a("1.1.1.1", "WWW"), ctx({ existing })))).toEqual([
      "VALIDATION_FAILED",
    ]);
  });
});

describe("recordContent / recordDataEquals / describeRecord", () => {
  it.each([
    [a("1.2.3.4"), "1.2.3.4"],
    [aaaa("2001:4860:4860:0::8888"), "2001:4860:4860::8888"],
    [cname("Alice.GitHub.io."), "alice.github.io"],
    [txt("Hello"), "Hello"],
    [mx("MX1.example.com"), "10 mx1.example.com"],
    [srv("_a._tcp"), "0 5 25565 mc.example.net"],
    [caa("issue", "letsencrypt.org"), '0 issue "letsencrypt.org"'],
  ])("%j → %s", (r, content) => {
    expect(recordContent(r)).toBe(content);
  });

  it("compares type and data only", () => {
    expect(recordDataEquals(a("1.2.3.4", "@"), a("1.2.3.4", "www"))).toBe(true);
    expect(recordDataEquals(a("1.2.3.4"), txt("1.2.3.4"))).toBe(false);
    expect(describeRecord(mx("mx.example.com"))).toBe("@ MX 10 mx.example.com");
  });
});
