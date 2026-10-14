import type { RecordInput } from "@dit/contract";
import { describe, expect, it } from "vitest";
import { LAZCO_RESERVED_LABEL, providerViolations, validateRecord } from "../src/index.ts";
import { codesOf, ctx } from "./helpers.ts";

const txt = (value: string, name = "@"): RecordInput => ({ type: "TXT", name, ttl: 300, value });
const caa = (value: string): RecordInput => ({
  type: "CAA",
  name: "@",
  ttl: 300,
  flags: 0,
  tag: "issue",
  value,
});
const mx = (exchange: string): RecordInput => ({
  type: "MX",
  name: "@",
  ttl: 300,
  priority: 10,
  exchange,
});
const srv = (target: string): RecordInput => ({
  type: "SRV",
  name: "_minecraft._tcp",
  ttl: 300,
  priority: 0,
  weight: 5,
  port: 25565,
  target,
});

describe("providerViolations", () => {
  it("adds nothing for Cloudflare and the memory provider", () => {
    for (const provider of ["cloudflare", "memory"] as const) {
      expect(providerViolations(txt('say "hi"'), provider)).toEqual([]);
      expect(providerViolations(mx("_mail.example.com"), provider)).toEqual([]);
    }
  });

  it("refuses quotes and backslashes in TXT and CAA values for Lazco DNS", () => {
    expect(providerViolations(txt('say "hi"'), "lazco").map((v) => v.path)).toEqual(["value"]);
    expect(providerViolations(txt("a\\b"), "lazco")).toHaveLength(1);
    expect(providerViolations(caa('letsencrypt.org"'), "lazco")).toHaveLength(1);
    expect(providerViolations(txt("v=spf1 include:_spf.google.com ~all"), "lazco")).toEqual([]);
    expect(providerViolations(caa("letsencrypt.org"), "lazco")).toEqual([]);
  });

  it("requires LDH host names for MX and SRV targets", () => {
    expect(providerViolations(mx("_mail.example.com"), "lazco").map((v) => v.path)).toEqual([
      "exchange",
    ]);
    expect(providerViolations(srv("mc_1.example.com"), "lazco").map((v) => v.path)).toEqual([
      "target",
    ]);
    expect(providerViolations(mx("mx1.improvmx.com"), "lazco")).toEqual([]);
    expect(providerViolations(srv("mc.example.com"), "lazco")).toEqual([]);
  });

  it("refuses the reserved _lazco-verify label", () => {
    expect(providerViolations(txt("x", LAZCO_RESERVED_LABEL), "lazco")).toHaveLength(1);
    expect(providerViolations(txt("x", `a.${LAZCO_RESERVED_LABEL}`), "lazco")).toHaveLength(1);
    expect(providerViolations(txt("x", "_lazco"), "lazco")).toEqual([]);
  });

  it("runs from validateRecord only when the context names a provider", () => {
    expect(validateRecord(txt('say "hi"'), ctx()).ok).toBe(true);
    expect(codesOf(validateRecord(txt('say "hi"'), ctx({ provider: "lazco" })))).toEqual([
      "VALIDATION_FAILED",
    ]);
    expect(validateRecord(txt('say "hi"'), ctx({ provider: "cloudflare" })).ok).toBe(true);
  });
});
