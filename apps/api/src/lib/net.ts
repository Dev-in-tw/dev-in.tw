import { isIP } from "node:net";
import { sha256Hex } from "./crypto.ts";

/** 去掉 IPv4-mapped IPv6 的前綴（::ffff:1.2.3.4 → 1.2.3.4），不合法時回 null */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  if (ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

/**
 * 依 TRUSTED_PROXY_HOPS 取得 client IP。每一層受信任的 proxy 會把它看到的來源附加到
 * X-Forwarded-For 尾端，所以從右邊數第 hops 個才是真正的 client；左邊的值都可以被偽造。
 */
export function resolveClientIp(
  forwardedFor: string | undefined | null,
  socketAddress: string | undefined | null,
  hops: number,
): string | null {
  const socket = normalizeIp(socketAddress);
  if (hops <= 0) return socket;
  const chain = (forwardedFor ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (chain.length === 0) return socket;
  const candidate = chain[Math.max(0, chain.length - hops)];
  return normalizeIp(candidate) ?? socket;
}

/** 給使用者看的大略位置："203.0.113.x"、"2001:db8:1234::/48" */
export function approximateIp(ip: string | null): string | null {
  if (!ip) return null;
  if (isIP(ip) === 4) return `${ip.split(".").slice(0, 3).join(".")}.x`;
  const groups = ip.split(":").filter(Boolean).slice(0, 3);
  return `${groups.join(":")}::/48`;
}

export const hashIp = (ip: string | null, salt: string): string | null =>
  ip ? sha256Hex(`${ip}|${salt}`).slice(0, 32) : null;
