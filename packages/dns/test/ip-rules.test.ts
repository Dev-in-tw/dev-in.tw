import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalIPv6,
  DENIED_IPV4_RANGES,
  describeNonPublicIPv4,
  describeNonPublicIPv6,
  formatIPv6,
  isIPAddress,
  isPublicIPv4,
  isPublicIPv6,
  parseIPv4,
  parseIPv6,
} from "../src/index.ts";

const toIPv4 = (n: number) =>
  [
    Math.floor(n / 2 ** 24) % 256,
    Math.floor(n / 2 ** 16) % 256,
    Math.floor(n / 256) % 256,
    n % 256,
  ].join(".");

describe("parseIPv4", () => {
  it.each([
    ["0.0.0.0", 0],
    ["1.2.3.4", 0x01020304],
    ["255.255.255.255", 0xffffffff],
  ])("parses %s", (ip, value) => {
    expect(parseIPv4(ip)).toBe(value);
  });

  it.each([
    "",
    "1.2.3",
    "1.2.3.4.5",
    "256.0.0.1",
    "01.2.3.4",
    "1.2.3.04",
    "1.2.3.a",
    "1..2.3",
    " 1.2.3.4",
    "1.2.3.1000",
    "-1.2.3.4",
  ])("rejects %j", (ip) => {
    expect(parseIPv4(ip)).toBeNull();
  });

  it("round-trips every uint32", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (n) => parseIPv4(toIPv4(n)) === n),
    );
  });
});

describe("isPublicIPv4", () => {
  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "185.199.108.153",
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.0.1.0",
    "192.0.3.0",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "198.51.99.255",
    "198.51.101.0",
    "203.0.112.255",
    "203.0.114.0",
    "223.255.255.255",
  ])("accepts public address %s", (ip) => {
    expect(isPublicIPv4(ip)).toBe(true);
    expect(describeNonPublicIPv4(ip)).toBeNull();
  });

  it.each([
    ["0.0.0.0", "「本網路」保留網段"],
    ["0.255.255.255", "「本網路」保留網段"],
    ["10.0.0.0", "私有網段"],
    ["10.255.255.255", "私有網段"],
    ["100.64.0.0", "電信業者 NAT（CGNAT）網段"],
    ["100.127.255.255", "電信業者 NAT（CGNAT）網段"],
    ["127.0.0.1", "本機（loopback）位址"],
    ["127.255.255.255", "本機（loopback）位址"],
    ["169.254.0.0", "鏈路本地（link-local）位址"],
    ["169.254.169.254", "鏈路本地（link-local）位址"],
    ["172.16.0.0", "私有網段"],
    ["172.31.255.255", "私有網段"],
    ["192.0.0.0", "IETF 協定保留網段"],
    ["192.0.0.255", "IETF 協定保留網段"],
    ["192.0.2.0", "文件範例用網段"],
    ["192.0.2.255", "文件範例用網段"],
    ["192.168.0.0", "私有網段"],
    ["192.168.255.255", "私有網段"],
    ["198.18.0.0", "效能測試用網段"],
    ["198.19.255.255", "效能測試用網段"],
    ["198.51.100.0", "文件範例用網段"],
    ["198.51.100.255", "文件範例用網段"],
    ["203.0.113.0", "文件範例用網段"],
    ["203.0.113.255", "文件範例用網段"],
    ["224.0.0.0", "群播（multicast）位址"],
    ["239.255.255.255", "群播（multicast）位址"],
    ["240.0.0.0", "保留網段"],
    ["255.255.255.254", "保留網段"],
    ["255.255.255.255", "保留網段"],
  ])("rejects %s (%s)", (ip, label) => {
    expect(isPublicIPv4(ip)).toBe(false);
    expect(describeNonPublicIPv4(ip)).toBe(label);
  });

  it("rejects malformed input", () => {
    expect(isPublicIPv4("1.2.3")).toBe(false);
    expect(describeNonPublicIPv4("nope")).toBe("不是合法的 IPv4 位址");
  });

  it("covers the broadcast range explicitly", () => {
    expect(DENIED_IPV4_RANGES.some((r) => r.prefix === 32)).toBe(true);
  });

  it("agrees with the deny list for random addresses", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (n) => {
        const ip = toIPv4(n);
        const denied = DENIED_IPV4_RANGES.some((r) => {
          const size = 2 ** (32 - r.prefix);
          return Math.floor(n / size) === Math.floor(r.base / size);
        });
        return isPublicIPv4(ip) === !denied;
      }),
    );
  });
});

describe("parseIPv6", () => {
  it.each([
    ["::", [0, 0, 0, 0, 0, 0, 0, 0]],
    ["::1", [0, 0, 0, 0, 0, 0, 0, 1]],
    ["1::", [1, 0, 0, 0, 0, 0, 0, 0]],
    ["2001:db8::8:800:200c:417a", [0x2001, 0xdb8, 0, 0, 8, 0x800, 0x200c, 0x417a]],
    ["2001:DB8:0:0:8:800:200C:417A", [0x2001, 0xdb8, 0, 0, 8, 0x800, 0x200c, 0x417a]],
    ["1:2:3:4:5:6:7:8", [1, 2, 3, 4, 5, 6, 7, 8]],
    ["1:2:3:4:5:6:7::", [1, 2, 3, 4, 5, 6, 7, 0]],
    ["::ffff:1.2.3.4", [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]],
    ["::1.2.3.4", [0, 0, 0, 0, 0, 0, 0x0102, 0x0304]],
    ["1:2:3:4:5:6:1.2.3.4", [1, 2, 3, 4, 5, 6, 0x0102, 0x0304]],
    ["64:ff9b::192.0.2.33", [0x64, 0xff9b, 0, 0, 0, 0, 0xc000, 0x0221]],
  ])("parses %s", (ip, groups) => {
    expect(parseIPv6(ip)).toEqual(groups);
  });

  it.each([
    "",
    ":",
    "1.2.3.4",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7",
    "1::2::3",
    ":1::2",
    "1::2:",
    "1:2:3:4:5:6:7:",
    "1::2:3:4:5:6:7:8",
    "12345::1",
    "g::1",
    "fe80::1%eth0",
    "::ffff:1.2.3",
    "::ffff:256.1.1.1",
    "1:2:3:4:5:6:7:1.2.3.4",
    `${"1:".repeat(30)}1`,
  ])("rejects %j", (ip) => {
    expect(parseIPv6(ip)).toBeNull();
  });

  it("accepts every address fast-check generates (all RFC 4291 text forms)", () => {
    fc.assert(fc.property(fc.ipV6(), (ip) => parseIPv6(ip) !== null));
  });

  it("round-trips through formatIPv6", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 }),
        (g) => {
          expect(parseIPv6(formatIPv6(g))).toEqual(g);
        },
      ),
    );
  });
});

describe("formatIPv6 / canonicalIPv6", () => {
  it.each([
    ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
    ["2001:db8:0:1:0:0:0:1", "2001:db8:0:1::1"],
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["2001:db8:1:1:1:1:0:1", "2001:db8:1:1:1:1:0:1"],
    ["0:0:0:0:0:0:0:0", "::"],
    ["1:0:0:0:0:0:0:0", "1::"],
    ["2606:50C0:8000::153", "2606:50c0:8000::153"],
  ])("%s → %s", (input, out) => {
    expect(canonicalIPv6(input)).toBe(out);
  });

  it("returns malformed input unchanged", () => {
    expect(canonicalIPv6("not-an-ip")).toBe("not-an-ip");
  });
});

describe("isPublicIPv6", () => {
  it.each([
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2606:50c0:8000::153",
    "2000::",
    "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:db9::",
    "2001::1",
    "2002:c000:0204::1",
  ])("accepts global unicast %s", (ip) => {
    expect(isPublicIPv6(ip)).toBe(true);
  });

  it.each([
    ["::", "未指定位址"],
    ["::1", "本機（loopback）位址"],
    ["::ffff:8.8.8.8", "IPv4 對應位址"],
    ["::ffff:0:0", "IPv4 對應位址"],
    ["64:ff9b::808:808", "NAT64 轉換位址"],
    ["100::", "丟棄用（discard）網段"],
    ["100::ffff:ffff:ffff:ffff", "丟棄用（discard）網段"],
    ["2001:db8::", "文件範例用網段"],
    ["2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", "文件範例用網段"],
    ["fc00::1", "私有（ULA）網段"],
    ["fdff:ffff::1", "私有（ULA）網段"],
    ["fe80::1", "鏈路本地（link-local）位址"],
    ["febf:ffff::1", "鏈路本地（link-local）位址"],
    ["ff02::1", "群播（multicast）位址"],
    ["1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "不在全球單播（2000::/3）範圍內"],
    ["4000::", "不在全球單播（2000::/3）範圍內"],
    ["fec0::1", "不在全球單播（2000::/3）範圍內"],
    ["100:0:0:1::", "不在全球單播（2000::/3）範圍內"],
  ])("rejects %s (%s)", (ip, label) => {
    expect(isPublicIPv6(ip)).toBe(false);
    expect(describeNonPublicIPv6(ip)).toBe(label);
  });

  it("rejects malformed input and zone ids", () => {
    expect(isPublicIPv6("fe80::1%en0")).toBe(false);
    expect(describeNonPublicIPv6("2001::g")).toBe("不是合法的 IPv6 位址");
  });
});

describe("isIPAddress", () => {
  it("detects both families and rejects hostnames", () => {
    expect(isIPAddress("1.2.3.4")).toBe(true);
    expect(isIPAddress("2001:db8::1")).toBe(true);
    expect(isIPAddress("example.com")).toBe(false);
    expect(isIPAddress("1.2.3.4.nip.io")).toBe(false);
  });
});
