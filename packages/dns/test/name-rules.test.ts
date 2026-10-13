import { SUBDOMAIN_LABEL_RE } from "@dit/contract";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BRAND_NAMES,
  checkLabelSyntax,
  confusableWith,
  isPremiumLength,
  leetSkeleton,
  normalizeLabel,
  RESERVED_SEED,
  withinOneEdit,
} from "../src/index.ts";

const codes = (label: string) => {
  const v = checkLabelSyntax(label);
  return v.ok ? [] : v.violations.map((x) => x.code);
};

describe("normalizeLabel", () => {
  it.each([
    ["  Alice  ", "alice"],
    ["ＡＬＩＣＥ", "alice"],
    ["ａｌｉｃｅ－ｄｅｖ", "alice-dev"],
    ["alice.", "alice"],
    ["alice。", "alice"],
    ["ｘｎ－－abc", "xn--abc"],
    ["１２３", "123"],
  ])("%j → %j", (input, out) => {
    expect(normalizeLabel(input)).toBe(out);
  });

  it("is idempotent for single-dot inputs", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = normalizeLabel(s);
        return once.endsWith(".") || normalizeLabel(once) === once;
      }),
    );
  });
});

describe("checkLabelSyntax", () => {
  it.each(["abc", "alice", "alice-dev", "a1b", "123", "x".repeat(32), "a-b-c"])(
    "accepts %s",
    (label) => {
      expect(checkLabelSyntax(label)).toEqual({ ok: true });
    },
  );

  it.each([
    ["", ["NAME_TOO_SHORT"]],
    ["ab", ["NAME_TOO_SHORT"]],
    ["x".repeat(33), ["NAME_TOO_LONG"]],
    ["Alice", ["NAME_INVALID_CHARS"]],
    ["alice_dev", ["NAME_INVALID_CHARS"]],
    ["alice.dev", ["NAME_INVALID_CHARS"]],
    ["愛麗絲abc", ["NAME_INVALID_CHARS"]],
    ["-alice", ["NAME_EDGE_HYPHEN"]],
    ["alice-", ["NAME_EDGE_HYPHEN"]],
    ["al--ice", ["NAME_DOUBLE_HYPHEN"]],
    ["xn--p1ai", ["NAME_DOUBLE_HYPHEN"]],
    ["-", ["NAME_TOO_SHORT", "NAME_EDGE_HYPHEN"]],
    ["--a_", ["NAME_INVALID_CHARS", "NAME_EDGE_HYPHEN", "NAME_DOUBLE_HYPHEN"]],
  ])("rejects %j with %j", (label, expected) => {
    expect(codes(label)).toEqual(expected);
  });

  it("uses the name path and explains punycode", () => {
    const verdict = checkLabelSyntax("xn--abc");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations[0]?.path).toBe("name");
      expect(verdict.violations[0]?.message).toContain("xn--");
    }
    const plain = checkLabelSyntax("a--b");
    if (!plain.ok) expect(plain.violations[0]?.message).not.toContain("xn--");
  });

  it("agrees with the contract's SubdomainLabel regex", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9_.-]{0,40}$/), (label) => {
        return checkLabelSyntax(label).ok === SUBDOMAIN_LABEL_RE.test(label);
      }),
    );
  });
});

describe("isPremiumLength", () => {
  it.each([
    ["a", true],
    ["x1", true],
    ["abc", false],
    ["", false],
    ["-", false],
    ["A", false],
  ])("%j → %s", (label, expected) => {
    expect(isPremiumLength(label)).toBe(expected);
  });
});

describe("leetSkeleton", () => {
  it.each([
    ["g00gle", "google"],
    ["paypa1", "paypal"],
    ["faceb00k", "facebook"],
    ["1nstagram", "lnstagram"],
    ["instagram", "lnstagram"],
    ["m3t4m45k", "metamask"],
    ["7-eleven", "televen"],
    ["Pay-Pal", "paypal"],
  ])("%s → %s", (input, out) => {
    expect(leetSkeleton(input)).toBe(out);
  });

  it("is idempotent (property)", () => {
    fc.assert(fc.property(fc.string(), (s) => leetSkeleton(leetSkeleton(s)) === leetSkeleton(s)));
  });
});

describe("withinOneEdit", () => {
  it.each([
    ["google", "google", true],
    ["google", "googie", true],
    ["google", "gogle", true],
    ["google", "googgle", true],
    ["google", "goolge", true],
    ["google", "ogogle", true],
    ["google", "gooxlx", false],
    ["google", "goo", false],
    ["abc", "bca", false],
    ["ab", "ba", true],
    ["abcd", "badc", false],
    ["", "a", true],
  ])("%s ~ %s → %s", (a, b, expected) => {
    expect(withinOneEdit(a, b)).toBe(expected);
    expect(withinOneEdit(b, a)).toBe(expected);
  });
});

describe("confusableWith", () => {
  it("exposes the brand list from the seed", () => {
    expect(BRAND_NAMES).toContain("paypal");
    expect(BRAND_NAMES).toContain("ctbc");
    expect(BRAND_NAMES).not.toContain("www");
    expect(BRAND_NAMES.length).toBe(RESERVED_SEED.filter((r) => r.category === "brand").length);
  });

  // §3.9 誤判防護：這組一般名稱不能被送審
  const ORDINARY =
    "alex nextjs pipeline online olive metal bird laws api-tools xavier linear postgres pixel".split(
      " ",
    );
  it.each(ORDINARY)("does not flag the ordinary name %s", (name) => {
    expect(confusableWith(name, BRAND_NAMES)).toBeNull();
  });

  it.each([
    ["g00gle", "google"],
    ["paypa1", "paypal"],
    ["paypal-login", "paypal"],
    ["googie", "google"],
    ["faceb00k", "facebook"],
    ["my-github", "github"],
    ["G00GLE", "google"],
    ["netflix-tw", "netflix"],
    ["cl0udflare", "cloudflare"],
  ])("flags %s as %s", (name, brand) => {
    expect(confusableWith(name, BRAND_NAMES)).toBe(brand);
  });

  it("matches short brands only exactly", () => {
    expect(confusableWith("ctbc", BRAND_NAMES)).toBe("ctbc");
    expect(confusableWith("aws", BRAND_NAMES)).toBe("aws");
    expect(confusableWith("ctbc-bank", BRAND_NAMES)).toBeNull();
    expect(confusableWith("awss", BRAND_NAMES)).toBeNull();
    expect(confusableWith("metal", BRAND_NAMES)).toBeNull();
    expect(confusableWith("pi", BRAND_NAMES)).toBe("pi");
  });

  it("prefers an exact match over a fuzzy one", () => {
    expect(confusableWith("live", ["olive", "live"])).toBe("live");
    expect(confusableWith("Steam", BRAND_NAMES)).toBe("steam");
  });

  it("returns null for an empty brand list", () => {
    expect(confusableWith("google", [])).toBeNull();
  });
});
