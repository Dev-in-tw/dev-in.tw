import { describe, expect, it } from "vitest";
import { healthProbe } from "../src/http/app.ts";

/** 2026-10 安全稽核（docs/security/AUDIT-2026-10.md）的回歸測試：公開健康檢查不放大 DB 查詢 */

describe("health probe", () => {
  it("shares one database ping per second across concurrent and repeated probes", async () => {
    let now = 0;
    let pings = 0;
    const probe = healthProbe(
      async () => {
        pings++;
        return true;
      },
      1000,
      () => now,
    );
    await Promise.all(Array.from({ length: 50 }, () => probe()));
    expect(pings).toBe(1);
    now += 999;
    expect(await probe()).toBe(true);
    expect(pings).toBe(1);
    now += 1;
    await probe();
    expect(pings).toBe(2);
  });

  it("does not cache a failure for longer than the window", async () => {
    let now = 0;
    let healthy = false;
    const probe = healthProbe(
      async () => healthy,
      1000,
      () => now,
    );
    expect(await probe()).toBe(false);
    healthy = true;
    now += 1000;
    expect(await probe()).toBe(true);
  });
});
