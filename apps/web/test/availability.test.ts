import { availability as fixtures } from "@dit/contract/fixtures";
import { describe, expect, it } from "vitest";
import {
  availabilityReducer,
  initialAvailability,
  isClaimable,
  normalizeInput,
  toneOf,
} from "../lib/availability.ts";

describe("availability state machine", () => {
  it("normalizes what people paste into the prompt", () => {
    expect(normalizeInput("  Alice ")).toBe("alice");
    expect(normalizeInput("ＡＬＩＣＥ")).toBe("alice");
    expect(normalizeInput("alice.dev-in.tw")).toBe("alice");
    expect(normalizeInput("my site_tw")).toBe("my-site-tw");
  });

  it("goes idle → typing → checking → result", () => {
    let s = availabilityReducer(initialAvailability, { type: "input", value: "alice" });
    expect(s).toMatchObject({ phase: "typing", name: "alice", seq: 1 });
    s = availabilityReducer(s, { type: "check", seq: 1 });
    expect(s.phase).toBe("checking");
    s = availabilityReducer(s, { type: "result", seq: 1, result: fixtures.available });
    expect(s).toMatchObject({ phase: "result", result: { status: "available" } });
  });

  it("drops late responses for a previous name", () => {
    let s = availabilityReducer(initialAvailability, { type: "input", value: "bob" });
    s = availabilityReducer(s, { type: "check", seq: 1 });
    s = availabilityReducer(s, { type: "input", value: "bobby" });
    const after = availabilityReducer(s, { type: "result", seq: 1, result: fixtures.taken });
    expect(after).toBe(s);
    expect(after.phase).toBe("typing");
  });

  it("returns to idle when cleared and ignores results while idle", () => {
    let s = availabilityReducer(initialAvailability, { type: "input", value: "x" });
    s = availabilityReducer(s, { type: "input", value: "   " });
    expect(s.phase).toBe("idle");
    expect(availabilityReducer(s, { type: "result", seq: s.seq, result: fixtures.available })).toBe(
      s,
    );
  });

  it("records errors for the current lookup", () => {
    let s = availabilityReducer(initialAvailability, { type: "input", value: "alice" });
    s = availabilityReducer(s, { type: "check", seq: 1 });
    s = availabilityReducer(s, { type: "error", seq: 1, message: "操作太頻繁" });
    expect(s).toMatchObject({ phase: "error", message: "操作太頻繁" });
  });

  it("maps every status to a tone and claimability", () => {
    expect(isClaimable("available")).toBe(true);
    expect(isClaimable("review")).toBe(true);
    for (const status of ["taken", "reserved", "invalid", "cooldown", "capacity_full"] as const) {
      expect(isClaimable(status)).toBe(false);
    }
    expect(toneOf("available")).toBe("ok");
    expect(toneOf("review")).toBe("warn");
    expect(toneOf("taken")).toBe("no");
  });
});
