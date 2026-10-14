import { describe, expect, it } from "vitest";
import { MINUTE_MS, RateLimiter, RULES } from "../src/http/middleware/rate-limit.ts";
import { rateKeyForIp } from "../src/lib/net.ts";

/** 2026-10 安全稽核（docs/security/AUDIT-2026-10.md）的回歸測試：限流的 key 與記憶體上限 */

describe("rate limit keys", () => {
  it("keys IPv6 clients by /64 and IPv4 clients by address", () => {
    expect(rateKeyForIp("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(rateKeyForIp("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(rateKeyForIp("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(rateKeyForIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(rateKeyForIp("203.0.113.9")).toBe("203.0.113.9");
    expect(rateKeyForIp(null)).toBe("unknown");
    expect(rateKeyForIp("not-an-ip")).toBe("unknown");
  });
});

describe("rate limiter memory bound", () => {
  it("drops buckets that have refilled at the next sweep", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    for (let i = 0; i < 500; i++) limiter.take(RULES.global, `10.0.${i >> 8}.${i & 255}`);
    expect(limiter.size).toBe(500);
    now += 2 * MINUTE_MS;
    limiter.take(RULES.global, "198.51.100.1");
    expect(limiter.size).toBe(1);
  });

  it("never holds more than maxBuckets and evicts the least recently used first", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now, { maxBuckets: 100 });
    // 一個一直在用、已經被限流的 key
    const hot = "203.0.113.50";
    for (let i = 0; i < RULES.report.capacity; i++) limiter.take(RULES.report, hot);
    expect(limiter.take(RULES.report, hot).ok).toBe(false);
    for (let i = 0; i < 1000; i++) {
      now += 1;
      limiter.take(RULES.global, `key-${i}`);
      if (i % 50 === 0) limiter.take(RULES.report, hot);
    }
    expect(limiter.size).toBeLessThanOrEqual(100);
    // 輪換大量 key 不能把正在限流中的 bucket 擠掉
    expect(limiter.take(RULES.report, hot).ok).toBe(false);
  });
});
