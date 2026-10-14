import type { RecordInput } from "@dit/contract";
import { describe, expect, it } from "vitest";
import {
  isSpecialUseHostname,
  RESERVED_SEED,
  SPECIAL_USE_SUFFIXES,
  validateRecord,
} from "../src/index.ts";
import { codesOf, ctx } from "./helpers.ts";

const cname = (target: string, name = "www"): RecordInput => ({
  type: "CNAME",
  name,
  ttl: 300,
  target,
});
const mx = (exchange: string): RecordInput => ({
  type: "MX",
  name: "@",
  ttl: 3600,
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
const txt = (name: string): RecordInput => ({ type: "TXT", name, ttl: 300, value: "x" });

describe("special-use targets (audit 2026-10, defense in depth against internal names)", () => {
  const internal = [
    "printer.local",
    "kubernetes.default.svc.cluster.local",
    "metadata.google.internal",
    "app.localhost",
    "router.home.arpa",
    "1.0.0.127.in-addr.arpa",
    "nas.lan",
    "intranet.corp",
    "srv.home",
    "db.private",
    "x.test",
    "x.example",
    "x.invalid",
    "abc.onion",
    "x.localdomain",
  ];

  it.each(internal)("rejects CNAME, MX and SRV targets under %s", (host) => {
    for (const input of [cname(host), mx(host), srv(host)]) {
      const verdict = validateRecord(input, ctx());
      expect(codesOf(verdict)).toContain("RECORD_TARGET_NOT_ALLOWED");
    }
  });

  it("keeps ordinary public hostnames working", () => {
    for (const host of [
      "alice.github.io",
      "cname.vercel-dns.com",
      "my-site.netlify.app",
      "mx1.improvmx.com",
      "local.example.com", // only the TLD matters
      "internal.tools.dev",
    ]) {
      expect(validateRecord(cname(host), ctx()).ok).toBe(true);
    }
  });

  it("matches only the last label", () => {
    expect(isSpecialUseHostname("foo.local")).toBe(true);
    expect(isSpecialUseHostname("local.foo.com")).toBe(false);
    expect(SPECIAL_USE_SUFFIXES).toContain("internal");
  });
});

describe("punycode record names (homograph phishing under a user subdomain)", () => {
  it.each(["xn--pypal-4ve", "login.xn--pypal-4ve", "_xn--x"])("rejects %s", (name) => {
    const verdict = validateRecord(txt(name), ctx());
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.violations.map((v) => v.path)).toContain("name");
  });

  it("still allows hyphenated verification and DKIM style labels", () => {
    for (const name of [
      "_github-pages-challenge-alice",
      "selector1._domainkey",
      "a--b",
      "_acme-challenge",
    ]) {
      expect(validateRecord(txt(name), ctx()).ok).toBe(true);
    }
  });
});

describe("reserved seed", () => {
  it("reserves names that clients probe automatically", () => {
    const names = new Set(RESERVED_SEED.map((r) => r.name));
    for (const n of ["wpad", "isatap", "mta-sts", "autodiscover", "autoconfig", "www", "api"]) {
      expect(names.has(n)).toBe(true);
    }
  });
});
