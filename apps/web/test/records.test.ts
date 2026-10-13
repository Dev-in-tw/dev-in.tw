import { records } from "@dit/contract/fixtures";
import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api/client.ts";
import { fieldErrors } from "../lib/errors.ts";
import { cnameHint, validateDraft } from "../lib/record-validate.ts";
import {
  digCommand,
  draftFromRecord,
  emptyDraft,
  recordValue,
  toInput,
  zoneFile,
  zoneLine,
  zoneTree,
} from "../lib/records.ts";

const ctx = {
  sub: "alice",
  root: "dev-in.tw",
  existing: [records.A, records.CNAME],
  ownedSubdomains: ["alice"],
  allowedTypes: ["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA"] as const,
};

describe("record drafts", () => {
  it("round-trips every fixture record through the form", () => {
    for (const r of Object.values(records)) {
      const input = toInput(draftFromRecord(r));
      expect(input).toMatchObject({ type: r.type, name: r.name, ttl: r.ttl });
      expect(recordValue(input as never)).toBe(recordValue(r));
    }
  });

  it("normalizes hostnames (trailing dot, uppercase)", () => {
    const d = { ...emptyDraft("CNAME"), name: "WWW", target: "Alice.GitHub.io." };
    expect(toInput(d)).toMatchObject({ name: "www", target: "alice.github.io" });
  });
});

describe("validation messages", () => {
  it("explains invalid IPv4 in plain zh-Hant", () => {
    const r = validateDraft({ ...emptyDraft("A"), name: "lab", address: "999.1.1.1" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.address).toContain("不是合法的 IPv4");
  });

  it("rejects private addresses with the shared @dit/dns rules", () => {
    const r = validateDraft({ ...emptyDraft("A"), name: "lab", address: "10.0.0.1" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.address).toMatch(/10\.0\.0\.1/);
  });

  it("asks for a hostname, not an IP, for CNAME", () => {
    const r = validateDraft({ ...emptyDraft("CNAME"), name: "blog", target: "1.2.3.4" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.target).toBeTruthy();
  });

  it("validates MX priority range and rejects types that are not allowed", () => {
    const mx = validateDraft(
      { ...emptyDraft("MX"), priority: "70000", exchange: "mx1.improvmx.com" },
      ctx,
    );
    expect(mx.ok).toBe(false);
    if (!mx.ok) expect(mx.errors.priority).toContain("0–65535");
    const caa = validateDraft(emptyDraft("CAA"), { ...ctx, allowedTypes: ["A", "CNAME"] });
    expect(caa.ok).toBe(false);
    if (!caa.ok) expect(caa.errors.type).toContain("CAA");
  });

  it("accepts a valid record", () => {
    const r = validateDraft(
      { ...emptyDraft("TXT"), name: "_atproto", value: "did=did:plc:abc" },
      ctx,
    );
    expect(r).toMatchObject({ ok: true, input: { type: "TXT", name: "_atproto" } });
  });

  it("hints CNAME exclusivity both ways", () => {
    expect(cnameHint({ ...emptyDraft("CNAME"), name: "@" }, ctx.existing)).toContain(
      "CNAME 不能和其他紀錄同名",
    );
    expect(cnameHint({ ...emptyDraft("TXT"), name: "www" }, ctx.existing)).toContain(
      "已經有 CNAME",
    );
    expect(cnameHint({ ...emptyDraft("TXT"), name: "blog" }, ctx.existing)).toBeNull();
  });

  it("maps server field issues onto form fields", () => {
    const error = new ApiError({
      type: "x",
      title: "t",
      status: 400,
      code: "IP_NOT_PUBLIC",
      requestId: "r",
      errors: [{ path: "address", code: "IP_NOT_PUBLIC", message: "必須是公網位址" }],
    });
    expect(fieldErrors(error)).toEqual({ address: "必須是公網位址" });
  });
});

describe("zone file output", () => {
  it("renders zone lines with trailing dots and quoted TXT", () => {
    expect(zoneLine(records.CNAME)).toMatch(/^www\s+300\s+IN {2}CNAME\s+alice\.github\.io\.$/);
    expect(zoneLine(records.TXT)).toContain('"5f2c1e9a7b3d4c6e8f0a1b2c3d4e5f"');
    expect(zoneFile("alice", [records.A, records.SRV])).not.toContain("_minecraft");
    expect(digCommand(records.CNAME)).toBe("dig +short www.alice.dev-in.tw CNAME @1.1.1.1");
  });

  it("builds a zone tree from record names", () => {
    const tree = zoneTree([
      records.A,
      records.MX,
      records.CNAME,
      records.SRV,
      { name: "a.b", type: "TXT" },
    ]);
    expect(tree.types).toEqual(["A", "MX"]);
    expect(tree.children.map((c) => c.label)).toEqual(["_tcp", "b", "www"]);
    expect(tree.children[1]?.children[0]).toMatchObject({
      label: "a",
      path: "a.b",
      types: ["TXT"],
    });
  });
});
