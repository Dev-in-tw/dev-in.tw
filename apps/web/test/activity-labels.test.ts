import { describe, expect, it } from "vitest";
import { actionLabel } from "../components/app/activity.tsx";

describe("activity labels", () => {
  it("explains the dangling CNAME warning to the subdomain owner", () => {
    expect(actionLabel("record.dangling_suspected")).toContain("可能被他人接管");
    expect(actionLabel("unknown.action")).toBe("unknown.action");
  });
});
