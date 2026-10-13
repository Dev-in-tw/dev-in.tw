import { type PresetId, PresetPlan, type RecordInput } from "@dit/contract";
import { describe, expect, it } from "vitest";
import {
  type PresetContext,
  type PresetPlanResult,
  planPreset,
  prefixedName,
  type Verdict,
} from "../src/index.ts";
import { ROOT, rec, SUB } from "./helpers.ts";

const base = (over: Partial<PresetContext> = {}): PresetContext => ({
  sub: SUB,
  root: ROOT,
  recordName: "@",
  githubLogin: "Alice",
  existing: [],
  ...over,
});

function plan(
  id: PresetId,
  params: Record<string, string> = {},
  over: Partial<PresetContext> = {},
): PresetPlanResult {
  const result = planPreset(id, params, base(over));
  if ("ok" in result) throw new Error(`expected a plan, got ${JSON.stringify(result)}`);
  expect(() => PresetPlan.parse(result)).not.toThrow();
  return result;
}

function fail(id: PresetId, params: Record<string, string>, over: Partial<PresetContext> = {}) {
  const result = planPreset(id, params, base(over)) as Verdict;
  expect("ok" in result && result.ok === false).toBe(true);
  return result.ok ? [] : result.violations;
}

const cname = (name: string, target: string): RecordInput => ({
  type: "CNAME",
  name,
  ttl: 1,
  target,
});
const txt = (name: string, value: string): RecordInput => ({ type: "TXT", name, ttl: 1, value });

describe("planPreset outputs", () => {
  it("github-pages defaults to the login and adds the verification TXT", () => {
    expect(plan("github-pages").creates).toEqual([cname("@", "alice.github.io")]);
    expect(
      plan("github-pages", { githubUser: "OctoCat", verifyToken: " abc123 " }).creates,
    ).toEqual([cname("@", "octocat.github.io"), txt("_github-pages-challenge-octocat", "abc123")]);
    expect(plan("github-pages", {}, { recordName: "blog" }).creates[0]).toEqual(
      cname("blog", "alice.github.io"),
    );
  });

  it("vercel uses the default target unless one is pasted", () => {
    expect(plan("vercel").creates).toEqual([cname("@", "cname.vercel-dns.com")]);
    expect(
      plan("vercel", { target: "ABC123.vercel-dns-017.com.", verifyTxt: "vc-domain-verify=x" })
        .creates,
    ).toEqual([cname("@", "abc123.vercel-dns-017.com"), txt("_vercel", "vc-domain-verify=x")]);
  });

  it("netlify, cloudflare-pages and fly build platform hostnames", () => {
    expect(plan("netlify", { site: "my-site" }).creates).toEqual([
      cname("@", "my-site.netlify.app"),
    ]);
    expect(plan("cloudflare-pages", { project: "proj" }).creates).toEqual([
      cname("@", "proj.pages.dev"),
    ]);
    expect(plan("fly", { app: "my-app" }).creates).toEqual([cname("@", "my-app.fly.dev")]);
  });

  it("zeabur and render take a pasted hostname", () => {
    expect(plan("zeabur", { target: "x.zeabur.app" }).creates).toEqual([
      cname("@", "x.zeabur.app"),
    ]);
    expect(
      plan("render", { target: "My-App.onrender.com" }, { recordName: "api" }).creates,
    ).toEqual([cname("api", "my-app.onrender.com")]);
  });

  it("bluesky puts _atproto in front of the record name", () => {
    expect(plan("bluesky", { did: "did:plc:abc123" }).creates).toEqual([
      txt("_atproto", "did=did:plc:abc123"),
    ]);
    expect(plan("bluesky", { did: "did:plc:abc123" }, { recordName: "me" }).creates).toEqual([
      txt("_atproto.me", "did=did:plc:abc123"),
    ]);
  });

  it("improvmx adds two MX and an SPF record", () => {
    expect(plan("improvmx").creates).toEqual([
      { type: "MX", name: "@", ttl: 1, priority: 10, exchange: "mx1.improvmx.com" },
      { type: "MX", name: "@", ttl: 1, priority: 20, exchange: "mx2.improvmx.com" },
      txt("@", "v=spf1 include:spf.improvmx.com ~all"),
    ]);
  });

  it("google-site-verification accepts the bare token or the whole value", () => {
    const expected = [txt("@", "google-site-verification=AbCdEf123_-x")];
    expect(plan("google-site-verification", { token: "AbCdEf123_-x" }).creates).toEqual(expected);
    expect(
      plan("google-site-verification", { token: "google-site-verification=AbCdEf123_-x" }).creates,
    ).toEqual(expected);
  });

  it("prefixedName", () => {
    expect(prefixedName("_x", "@")).toBe("_x");
    expect(prefixedName("_x", "a.b")).toBe("_x.a.b");
  });
});

describe("planPreset parameter validation", () => {
  it("requires required params and checks patterns", () => {
    expect(fail("netlify", {})).toEqual([
      {
        path: "params.site",
        code: "PRESET_PARAMS_INVALID",
        message: "「Netlify 網站名稱」是必填欄位",
      },
    ]);
    expect(fail("netlify", { site: "My_Site" })[0]?.path).toBe("params.site");
    expect(fail("github-pages", { githubUser: "-bad-" })[0]?.path).toBe("params.githubUser");
    expect(fail("github-pages", {}, { githubLogin: "" })[0]?.path).toBe("params.githubUser");
    expect(fail("bluesky", { did: "plc:abc" })[0]?.path).toBe("params.did");
  });

  it("rejects bad hostnames and TXT values", () => {
    expect(fail("zeabur", { target: "1.2.3.4" })[0]?.path).toBe("params.target");
    expect(fail("render", {})[0]?.path).toBe("params.target");
    expect(fail("vercel", { target: "not a host" })[0]?.path).toBe("params.target");
    expect(fail("vercel", { verifyTxt: "中文" })[0]?.path).toBe("params.verifyTxt");
    expect(fail("github-pages", { verifyToken: "x".repeat(256) })[0]?.path).toBe(
      "params.verifyToken",
    );
    expect(fail("google-site-verification", { token: "short" })[0]?.path).toBe("params.token");
  });

  it("rejects an invalid record name and an unknown preset", () => {
    expect(fail("netlify", { site: "x" }, { recordName: "Bad Name" })[0]?.path).toBe("recordName");
    expect(fail("nope" as PresetId, {})[0]?.path).toBe("presetId");
  });

  it("ignores unknown params", () => {
    expect(plan("netlify", { site: "s", extra: "1" }).creates).toHaveLength(1);
  });
});

describe("planPreset conflicts", () => {
  it("deletes records that conflict with a new CNAME", () => {
    const aRecord = rec({ type: "A", name: "@", ttl: 1, address: "1.2.3.4" });
    const mxRecord = rec({
      type: "MX",
      name: "@",
      ttl: 1,
      priority: 10,
      exchange: "mx.example.com",
    });
    const other = rec({ type: "A", name: "www", ttl: 1, address: "1.2.3.4" });
    const result = plan("github-pages", {}, { existing: [aRecord, mxRecord, other] });
    expect(result.deletes.map((r) => r.id)).toEqual([aRecord.id, mxRecord.id]);
    expect(result.warnings).toEqual([
      "現有的 @ A 會和 CNAME 衝突，套用時一併刪除",
      "現有的 @ MX 會和 CNAME 衝突，套用時一併刪除",
    ]);
  });

  it("replaces an existing CNAME with another one", () => {
    const old = rec(cname("@", "old.netlify.app"));
    const result = plan("netlify", { site: "new" }, { existing: [old] });
    expect(result.creates).toEqual([cname("@", "new.netlify.app")]);
    expect(result.deletes).toEqual([old]);
  });

  it("deletes a CNAME that blocks new TXT/MX records", () => {
    const old = rec(cname("_atproto", "elsewhere.example.com"));
    expect(plan("bluesky", { did: "did:plc:x" }, { existing: [old] }).deletes).toEqual([old]);
  });

  it("swaps mail providers and keeps a single SPF record", () => {
    const oldMx = rec({ type: "MX", name: "@", ttl: 1, priority: 5, exchange: "mx.zoho.com" });
    const oldSpf = rec(txt("@", "v=spf1 include:zoho.com ~all"));
    const verify = rec(txt("@", "google-site-verification=abcdefgh"));
    const result = plan("improvmx", {}, { existing: [oldMx, oldSpf, verify] });
    expect(result.deletes.map((r) => r.id)).toEqual([oldMx.id, oldSpf.id]);
    expect(result.creates).toHaveLength(3);
  });

  it("skips records that already exist and keeps them", () => {
    const keep = rec({
      type: "MX",
      name: "@",
      ttl: 300,
      priority: 10,
      exchange: "mx1.improvmx.com",
    });
    const result = plan("improvmx", {}, { existing: [keep] });
    expect(result.creates).toHaveLength(2);
    expect(result.deletes).toEqual([]);
    expect(result.warnings[0]).toContain("不會重複新增");

    const same = rec(cname("@", "alice.github.io"));
    const again = plan("github-pages", {}, { existing: [same] });
    expect(again.creates).toEqual([]);
    expect(again.deletes).toEqual([]);
  });
});
