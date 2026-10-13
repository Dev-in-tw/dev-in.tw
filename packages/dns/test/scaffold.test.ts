import { Preset, PresetId, SUBDOMAIN_NAME_RE } from "@dit/contract";
import { presets as fixturePresets } from "@dit/contract/fixtures";
import { describe, expect, it } from "vitest";
import { PRESETS, RESERVED_SEED, toFqdn } from "../src/index.ts";

// WP0 只驗證資料定義；規則本身的測試由 WP-A 補上（§3.12，覆蓋率 ≥ 95%）

describe("PRESETS", () => {
  it("covers every PresetId exactly once and parses with the contract schema", () => {
    expect(PRESETS.map((p) => p.id).sort()).toEqual([...PresetId.options].sort());
    for (const preset of PRESETS) expect(() => Preset.parse(preset)).not.toThrow();
  });

  it("matches the contract fixtures", () => {
    for (const fixture of fixturePresets) {
      expect(PRESETS.find((p) => p.id === fixture.id)).toEqual(fixture);
    }
  });

  it("param patterns are valid regular expressions", () => {
    for (const preset of PRESETS) {
      for (const param of preset.params) {
        if ("pattern" in param) expect(() => new RegExp(param.pattern)).not.toThrow();
      }
    }
  });
});

describe("RESERVED_SEED", () => {
  it("has unique, well-formed names", () => {
    const names = RESERVED_SEED.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(SUBDOMAIN_NAME_RE);
  });
});

describe("toFqdn", () => {
  it("maps @ to the subdomain itself", () => {
    expect(toFqdn("@", "alice", "dev-in.tw")).toBe("alice.dev-in.tw");
    expect(toFqdn("www", "alice", "dev-in.tw")).toBe("www.alice.dev-in.tw");
  });
});
