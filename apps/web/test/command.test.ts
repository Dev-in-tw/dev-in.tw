import { describe, expect, it } from "vitest";
import { addHref, parseCommand, parseTtl, tokenize } from "../lib/command.ts";

describe("command palette parser", () => {
  it("parses claim, go and dig with optional .dev-in.tw suffix", () => {
    expect(parseCommand("claim Alice")).toEqual({ kind: "claim", name: "alice" });
    expect(parseCommand("go alice.dev-in.tw")).toEqual({ kind: "go", name: "alice" });
    expect(parseCommand("dig dev-in.tw")).toEqual({ kind: "dig", name: "dev-in.tw" });
    expect(parseCommand("claim")).toMatchObject({ kind: "incomplete", usage: "claim <name>" });
  });

  it("parses add with type, name, value and optional ttl", () => {
    expect(parseCommand("add cname www alice.github.io")).toEqual({
      kind: "add",
      type: "CNAME",
      name: "www",
      value: "alice.github.io",
    });
    expect(parseCommand("add A @ 185.199.108.153 300")).toEqual({
      kind: "add",
      type: "A",
      name: "@",
      value: "185.199.108.153",
      ttl: 300,
    });
    expect(parseCommand('add txt @ "v=spf1 include:spf.improvmx.com ~all"')).toMatchObject({
      type: "TXT",
      value: "v=spf1 include:spf.improvmx.com ~all",
    });
    expect(parseCommand("add mx @ 10 mx1.improvmx.com")).toMatchObject({
      type: "MX",
      value: "10 mx1.improvmx.com",
    });
    expect(parseCommand("add bogus www x")).toMatchObject({ kind: "incomplete" });
  });

  it("parses theme, logout, help and unknown input", () => {
    expect(parseCommand("theme dark")).toEqual({ kind: "theme", theme: "dark" });
    expect(parseCommand("theme blue")).toMatchObject({ kind: "incomplete" });
    expect(parseCommand("logout")).toEqual({ kind: "logout" });
    expect(parseCommand("help")).toEqual({ kind: "help" });
    expect(parseCommand("rm -rf /")).toEqual({ kind: "unknown", input: "rm -rf /" });
    expect(parseCommand("   ")).toEqual({ kind: "empty" });
  });

  it("colours tokens by role and keeps whitespace so the overlay lines up", () => {
    const tokens = tokenize("add cname  www alice.github.io 5m");
    expect(tokens.map((t) => t.text).join("")).toBe("add cname  www alice.github.io 5m");
    expect(tokens.filter((t) => t.role !== "space").map((t) => t.role)).toEqual([
      "command",
      "type",
      "name",
      "value",
      "ttl",
    ]);
    expect(tokenize("add nope")[2]?.role).toBe("error");
    expect(tokenize("frobnicate")[0]?.role).toBe("error");
  });

  it("understands ttl words and builds the editor prefill url", () => {
    expect(parseTtl("auto")).toBe(1);
    expect(parseTtl("1h")).toBe(3600);
    expect(parseTtl("30")).toBeNaN();
    expect(
      addHref("alice", {
        kind: "add",
        type: "CNAME",
        name: "www",
        value: "alice.github.io",
        ttl: 300,
      }),
    ).toBe("/dashboard/alice/records?add=CNAME&name=www&value=alice.github.io&ttl=300");
  });
});
