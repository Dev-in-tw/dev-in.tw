import type { RecordInput } from "@dit/contract";
import { records } from "@dit/contract/fixtures";
import { describe, expect, it } from "vitest";
import { toZoneFile, toZoneLine, txtChunks, zoneData } from "../src/index.ts";

describe("toZoneLine", () => {
  it("renders every record type from the contract fixtures", () => {
    expect(toZoneLine(records.A)).toBe("@  1  IN  A  185.199.108.153");
    expect(toZoneLine(records.AAAA)).toBe("@  1  IN  AAAA  2606:50c0:8000::153");
    expect(toZoneLine(records.CNAME)).toBe("www  300  IN  CNAME  alice.github.io.");
    expect(toZoneLine(records.TXT)).toBe(
      '_github-pages-challenge-alice  3600  IN  TXT  "5f2c1e9a7b3d4c6e8f0a1b2c3d4e5f"',
    );
    expect(toZoneLine(records.MX)).toBe("@  3600  IN  MX  10 mx1.improvmx.com.");
    expect(toZoneLine(records.SRV)).toBe(
      "_minecraft._tcp  300  IN  SRV  0 5 25565 mc.example.net.",
    );
    expect(toZoneLine(records.CAA)).toBe('@  86400  IN  CAA  0 issue "letsencrypt.org"');
  });

  it("escapes quotes and backslashes in TXT and CAA", () => {
    const r: RecordInput = { type: "TXT", name: "@", ttl: 60, value: 'say "hi" \\o/' };
    expect(zoneData(r)).toBe('"say \\"hi\\" \\\\o/"');
    const c: RecordInput = {
      type: "CAA",
      name: "@",
      ttl: 60,
      flags: 128,
      tag: "iodef",
      value: 'mailto:"a"',
    };
    expect(zoneData(c)).toBe('128 iodef "mailto:\\"a\\""');
  });

  it("splits long TXT values into 255-character strings", () => {
    const value = `${"a".repeat(255)}${"b".repeat(255)}c`;
    expect(txtChunks(value)).toEqual(["a".repeat(255), "b".repeat(255), "c"]);
    const r: RecordInput = { type: "TXT", name: "@", ttl: 1, value };
    expect(zoneData(r)).toBe(`"${"a".repeat(255)}" "${"b".repeat(255)}" "c"`);
    expect(txtChunks("")).toEqual([""]);
  });

  it("normalizes hostnames to lowercase with exactly one trailing dot", () => {
    const r: RecordInput = { type: "CNAME", name: "www", ttl: 1, target: "Alice.GitHub.io." };
    expect(zoneData(r)).toBe("alice.github.io.");
  });
});

describe("toZoneFile", () => {
  it("aligns the name, ttl and type columns", () => {
    expect(toZoneFile([records.A, records.CNAME, records.MX])).toBe(
      [
        "@    1     IN  A      185.199.108.153",
        "www  300   IN  CNAME  alice.github.io.",
        "@    3600  IN  MX     10 mx1.improvmx.com.",
      ].join("\n"),
    );
  });

  it("returns an empty string for no records", () => {
    expect(toZoneFile([])).toBe("");
  });
});
