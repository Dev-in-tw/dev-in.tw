import { BlockList, isIP } from "node:net";

// https://www.cloudflare.com/ips/（2026-10-14 取得；變動極少，更新時同步改這裡）
const RANGES_V4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];
const RANGES_V6 = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

const cloudflare = new BlockList();
for (const cidr of RANGES_V4) {
  const [net, prefix] = cidr.split("/");
  cloudflare.addSubnet(net as string, Number(prefix), "ipv4");
}
for (const cidr of RANGES_V6) {
  const [net, prefix] = cidr.split("/");
  cloudflare.addSubnet(net as string, Number(prefix), "ipv6");
}

export function isCloudflareIp(ip: string | null): boolean {
  if (!ip) return false;
  const family = isIP(ip);
  return family !== 0 && cloudflare.check(ip, family === 4 ? "ipv4" : "ipv6");
}
