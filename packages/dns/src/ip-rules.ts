/**
 * IP 位址解析與公網判斷（§3.9）。純函式，不依賴 node:net，瀏覽器也能用。
 *
 * 拒絕清單完全依照 PLAN.md §3.9；IPv6 另外要求必須落在 2000::/3（global unicast）之內。
 * 刻意沒有額外拒絕 Teredo（2001::/32）與 6to4（2002::/16）：它們不在 §3.9 的清單裡，
 * 而且仍是可路由的位址。要收緊時改這裡的清單即可。
 */

type Range4 = { base: number; prefix: number; label: string };
type Range6 = { base: readonly number[]; prefix: number; label: string };

const DEC_OCTET = /^(?:0|[1-9]\d{0,2})$/;

/** 解析點分十進位 IPv4，回傳 uint32；不合法（含前導零）時回 null */
export function parseIPv4(input: string): number | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!DEC_OCTET.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const HEX_GROUP = /^[0-9a-f]{1,4}$/;

function parseGroups(part: string): number[] | null {
  if (part === "") return [];
  const out: number[] = [];
  for (const group of part.split(":")) {
    if (!HEX_GROUP.test(group)) return null;
    out.push(Number.parseInt(group, 16));
  }
  return out;
}

/** 解析 IPv6（支援 `::` 壓縮與結尾的內嵌 IPv4），回傳 8 個 16-bit 數值；不合法或帶 zone id 時回 null */
export function parseIPv6(input: string): number[] | null {
  if (input.length < 2 || input.length > 45 || input.includes("%")) return null;
  let text = input.toLowerCase();
  let tail: number[] = [];

  const lastColon = text.lastIndexOf(":");
  if (lastColon === -1) return null;
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 0x10000), v4 % 0x10000];
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }

  const compressed = text.indexOf("::");
  if (compressed !== -1 && text.indexOf("::", compressed + 1) !== -1) return null;

  if (compressed === -1) {
    const groups = parseGroups(text);
    if (groups === null) return null;
    const all = [...groups, ...tail];
    return all.length === 8 ? all : null;
  }

  const head = parseGroups(text.slice(0, compressed));
  const rest = parseGroups(text.slice(compressed + 2));
  if (head === null || rest === null) return null;
  const known = head.length + rest.length + tail.length;
  if (known > 7) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
}

/** RFC 5952 的標準文字格式（小寫、最長的連續 0 以 `::` 壓縮） */
export function formatIPv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLength < 2) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

/** 合法的 IPv6 轉成標準格式；不合法時原樣回傳 */
export function canonicalIPv6(input: string): string {
  const groups = parseIPv6(input);
  return groups === null ? input : formatIPv6(groups);
}

export function isIPAddress(input: string): boolean {
  return parseIPv4(input) !== null || parseIPv6(input) !== null;
}

function cidr4(text: string, label: string): Range4 {
  const [address = "", prefix = "32"] = text.split("/");
  const base = parseIPv4(address);
  /* v8 ignore next */
  if (base === null) throw new Error(`invalid range ${text}`);
  return { base, prefix: Number(prefix), label };
}

function cidr6(text: string, label: string): Range6 {
  const [address = "", prefix = "128"] = text.split("/");
  const base = parseIPv6(address);
  /* v8 ignore next */
  if (base === null) throw new Error(`invalid range ${text}`);
  return { base, prefix: Number(prefix), label };
}

/** §3.9 的 IPv4 拒絕清單 */
export const DENIED_IPV4_RANGES: readonly Range4[] = [
  cidr4("0.0.0.0/8", "「本網路」保留網段"),
  cidr4("10.0.0.0/8", "私有網段"),
  cidr4("100.64.0.0/10", "電信業者 NAT（CGNAT）網段"),
  cidr4("127.0.0.0/8", "本機（loopback）位址"),
  cidr4("169.254.0.0/16", "鏈路本地（link-local）位址"),
  cidr4("172.16.0.0/12", "私有網段"),
  cidr4("192.0.0.0/24", "IETF 協定保留網段"),
  cidr4("192.0.2.0/24", "文件範例用網段"),
  cidr4("192.168.0.0/16", "私有網段"),
  cidr4("198.18.0.0/15", "效能測試用網段"),
  cidr4("198.51.100.0/24", "文件範例用網段"),
  cidr4("203.0.113.0/24", "文件範例用網段"),
  cidr4("224.0.0.0/4", "群播（multicast）位址"),
  cidr4("240.0.0.0/4", "保留網段"),
  cidr4("255.255.255.255/32", "廣播位址"),
];

/** §3.9 的 IPv6 拒絕清單（另外整體必須在 2000::/3 之內） */
export const DENIED_IPV6_RANGES: readonly Range6[] = [
  cidr6("::/128", "未指定位址"),
  cidr6("::1/128", "本機（loopback）位址"),
  cidr6("::ffff:0:0/96", "IPv4 對應位址"),
  cidr6("64:ff9b::/96", "NAT64 轉換位址"),
  cidr6("100::/64", "丟棄用（discard）網段"),
  cidr6("2001:db8::/32", "文件範例用網段"),
  cidr6("fc00::/7", "私有（ULA）網段"),
  cidr6("fe80::/10", "鏈路本地（link-local）位址"),
  cidr6("ff00::/8", "群播（multicast）位址"),
];

const GLOBAL_UNICAST = cidr6("2000::/3", "全球單播");

function inRange4(ip: number, range: Range4): boolean {
  const size = 2 ** (32 - range.prefix);
  return Math.floor(ip / size) === Math.floor(range.base / size);
}

function inRange6(groups: readonly number[], range: Range6): boolean {
  let remaining = range.prefix;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const bits = Math.min(16, remaining);
    const mask = (0xffff << (16 - bits)) & 0xffff;
    if (((groups[i] ?? 0) & mask) !== ((range.base[i] ?? 0) & mask)) return false;
    remaining -= bits;
  }
  return true;
}

/**
 * IPv4 不能公開使用的原因（例如「私有網段」）；公網 unicast 回 null。
 * 不是合法的 IPv4 時回「不是合法的 IPv4 位址」。
 */
export function describeNonPublicIPv4(ip: string): string | null {
  const value = parseIPv4(ip);
  if (value === null) return "不是合法的 IPv4 位址";
  return DENIED_IPV4_RANGES.find((range) => inRange4(value, range))?.label ?? null;
}

/** IPv6 不能公開使用的原因；在 2000::/3 之內且不在拒絕清單時回 null */
export function describeNonPublicIPv6(ip: string): string | null {
  const groups = parseIPv6(ip);
  if (groups === null) return "不是合法的 IPv6 位址";
  const denied = DENIED_IPV6_RANGES.find((range) => inRange6(groups, range));
  if (denied) return denied.label;
  return inRange6(groups, GLOBAL_UNICAST) ? null : "不在全球單播（2000::/3）範圍內";
}

/** IPv4 必須是公網 unicast（§3.9 的拒絕清單） */
export function isPublicIPv4(ip: string): boolean {
  return describeNonPublicIPv4(ip) === null;
}

/** IPv6 必須在 2000::/3 之內，並排除 §3.9 列出的網段 */
export function isPublicIPv6(ip: string): boolean {
  return describeNonPublicIPv6(ip) === null;
}
