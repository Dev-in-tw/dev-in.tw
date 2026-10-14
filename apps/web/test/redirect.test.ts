import { describe, expect, it } from "vitest";
import { safeRedirect } from "../lib/redirect.ts";

/** 2026-10 安全稽核：登入後的導向只能是站內路徑（與 API 的 sanitizeRedirect 一致） */
describe("safeRedirect", () => {
  it("keeps same-site relative paths", () => {
    expect(safeRedirect("/dashboard/alice/records?tab=1#x")).toBe(
      "/dashboard/alice/records?tab=1#x",
    );
    expect(safeRedirect(["/claim/alice", "/admin"])).toBe("/claim/alice");
  });

  it.each([
    undefined,
    null,
    "",
    "dashboard",
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r\n/evil.example",
    "/%2F/ok-encoded-stays-a-path".replace("%2F", "\\"),
    "/\u0000",
    `/${"a".repeat(200)}`,
  ])("falls back for %j", (value) => {
    expect(safeRedirect(value)).toBe("/dashboard");
  });

  it("uses the provided fallback", () => {
    expect(safeRedirect("//evil.example", "/")).toBe("/");
  });
});
