import type { RecordType, ResolverId } from "@dit/contract";
import { canonicalIPv6 } from "@dit/dns";
import type { FetchLike } from "../http.ts";
import { decodeResponse, encodeQuery, RCODE } from "./dns-wire.ts";

/** 傳播檢查的四個 resolver（PLAN §2.1）。全部用 RFC 8484 wire format，不依賴各家的 JSON API。 */
export const RESOLVERS: readonly { id: ResolverId; label: string; url: string }[] = [
  { id: "cloudflare", label: "Cloudflare 1.1.1.1", url: "https://cloudflare-dns.com/dns-query" },
  { id: "google", label: "Google 8.8.8.8", url: "https://dns.google/dns-query" },
  { id: "quad9", label: "Quad9 9.9.9.9", url: "https://dns.quad9.net/dns-query" },
  { id: "quad101", label: "TWNIC Quad101", url: "https://dns.twnic.tw/dns-query" },
];

export interface ResolverResult {
  answers: string[];
  latencyMs: number | null;
  error: string | null;
  /** resolver 明確回答 NXDOMAIN（名稱不存在）；給 dangling CNAME 偵測用 */
  nxdomain?: boolean;
}

export interface DohResolver {
  query(resolver: ResolverId, fqdn: string, type: RecordType): Promise<ResolverResult>;
}

const host = (v: string | number | undefined) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/\.$/, "");

/** 期望值（DB 紀錄）與 resolver 回答共用的呈現格式，兩邊用字串相等比較 */
export function presentAnswer(type: RecordType, data: Record<string, string | number>): string {
  switch (type) {
    case "A":
      return String(data.address ?? "");
    case "AAAA":
      return canonicalIPv6(String(data.address ?? "")).toLowerCase();
    case "CNAME":
      return host(data.target);
    case "TXT":
      return String(data.value ?? "");
    case "MX":
      return `${data.priority} ${host(data.exchange)}`;
    case "SRV":
      return `${data.priority} ${data.weight} ${data.port} ${host(data.target)}`;
    case "CAA":
      return `${data.flags} ${data.tag} "${data.value}"`;
  }
}

export function createDohResolver(
  opts: { fetch?: FetchLike; timeoutMs?: number; now?: () => number } = {},
): DohResolver {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const now = opts.now ?? Date.now;

  return {
    async query(resolverId, fqdn, type) {
      const resolver = RESOLVERS.find((r) => r.id === resolverId);
      if (!resolver) return { answers: [], latencyMs: null, error: "未知的 resolver" };
      const started = now();
      try {
        const query = encodeQuery(fqdn, type, 0);
        const dns = Buffer.from(query).toString("base64url");
        const res = await doFetch(`${resolver.url}?dns=${dns}`, {
          headers: { Accept: "application/dns-message" },
          signal: AbortSignal.timeout(timeoutMs),
          // 只打固定的四個 resolver；不跟隨轉址，避免被導到其他主機
          redirect: "error",
        });
        if (!res.ok) return { answers: [], latencyMs: now() - started, error: "查詢失敗" };
        const message = decodeResponse(new Uint8Array(await res.arrayBuffer()));
        const latencyMs = now() - started;
        if (message.rcode === RCODE.NXDOMAIN) {
          return { answers: [], latencyMs, error: null, nxdomain: true };
        }
        if (message.rcode !== RCODE.NOERROR) return { answers: [], latencyMs, error: "查詢失敗" };
        const answers = message.answers
          .filter((a) => a.type === type)
          .map((a) => presentAnswer(type, a.data));
        return { answers: [...new Set(answers)], latencyMs, error: null };
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        const timedOut = name === "TimeoutError" || name === "AbortError";
        return { answers: [], latencyMs: null, error: timedOut ? "逾時" : "查詢失敗" };
      }
    },
  };
}
