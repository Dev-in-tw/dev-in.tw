import type { FetchLike } from "../../src/adapters/http.ts";

/**
 * 依 Lazco Cloud 公開 API 合約實作的假 Lazco DNS（cloud-backend `src/api/dns.ts` 轉發
 * cloud-infra-dns `dns-api`；2026-10-10 的 main）：
 *
 * - `GET /v1/dns/zones/{id}`、`GET /v1/dns/zones/{id}/rrsets`（含 apex NS，managed: true），ETag `"<version>"`
 * - `PATCH /v1/dns/zones/{id}/rrsets`：REPLACE／DELETE 批次，全有或全無，最多 100 個變更；
 *   沒有 If-Match 回 428、版本不符 412（帶 version）、同 zone 有寫入中 409 `DNS_CHANGE_IN_PROGRESS`
 *   （Retry-After: 2）、每個 UTC 日 90 批後 429 `DNS_DAILY_CHANGE_LIMIT`、驗證錯誤 422（issues 帶 index）、
 *   RRset 上限 422 `DNS_RRSET_LIMIT_REACHED`、DELETE 的 expectedRecords 不符 412
 * - 錯誤 envelope 是 cloud-backend 的 `{ error, code, timestamp, message, ...extra }`
 *
 * 值的正規化比照 `validateChanges`：主機名稱小寫加結尾點、AAAA 壓縮、TXT 加引號並每 255 位元組分段、
 * CAA `<flags> <tag> "<value>"`。測試可以注入故障（fail）。
 */

export interface FakeRrset {
  name: string;
  type: string;
  ttl: number;
  values: string[];
}

type Fault =
  | { kind: "in_progress" }
  | { kind: "rate_limited"; retryAfter: number }
  | { kind: "unavailable" }
  /** 套用後回 504 DNS_OUTCOME_UNKNOWN（變更其實已生效） */
  | { kind: "outcome_unknown" }
  /** 套用後回 202 status=pending */
  | { kind: "pending" }
  /** 在處理這次 PATCH 之前，有其他人改了 zone（版本 +1，可同時改內容） */
  | { kind: "concurrent"; apply?: (fake: FakeLazcoDns) => void }
  | { kind: "status"; status: number; code: string };

const WRITABLE = new Set(["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA", "HTTPS", "NS", "PTR"]);
const LDH = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.$/;
const OWNER = /^(?:\*|_?[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?)$/;
const DAY = 86_400_000;

class Issue extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const fail = (code: string, message: string): never => {
  throw new Issue(code, message);
};

const host = (raw: string, ldh: boolean): string => {
  const name = `${raw.trim().toLowerCase().replace(/\.$/, "")}.`;
  if (ldh && !LDH.test(name)) fail("DNS_VALUE_INVALID", `target "${raw}" must be LDH`);
  return name;
};

function quote(text: string): string {
  if (/["\\]/.test(text) || /[^\x20-\x7e]/.test(text)) {
    fail("DNS_VALUE_INVALID", "a TXT value must not hold a quote or a backslash");
  }
  return `"${text}"`;
}

/** 解析 "a" "b"（簡化版：不處理跳脫，含跳脫就拒絕，和 PowerDNS 的限制一致） */
function parseQuoted(value: string): string[] {
  const out: string[] = [];
  const re = /\s*"([^"\\]*)"\s*/gy;
  let m: RegExpExecArray | null = re.exec(value);
  let consumed = 0;
  while (m) {
    out.push(m[1] ?? "");
    consumed = re.lastIndex;
    m = re.exec(value);
  }
  if (consumed !== value.length || out.length === 0) {
    fail("DNS_VALUE_INVALID", "a TXT value must not hold a quote or a backslash");
  }
  return out;
}

function compressIPv6(value: string): string {
  try {
    return new URL(`http://[${value.trim()}]/`).hostname.slice(1, -1);
  } catch {
    return fail("DNS_VALUE_INVALID", "AAAA must be an IPv6 address");
  }
}

export function canonical(type: string, value: string): string {
  switch (type) {
    case "A":
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value.trim())) fail("DNS_VALUE_INVALID", "A");
      return value.trim();
    case "AAAA":
      return compressIPv6(value);
    case "CNAME":
    case "PTR":
    case "NS":
      return host(value, false);
    case "MX": {
      const [pref = "", target = ""] = value.trim().split(/\s+/);
      return `${Number(pref)} ${host(target, true)}`;
    }
    case "SRV": {
      const [p = "", w = "", port = "", target = ""] = value.trim().split(/\s+/);
      return `${Number(p)} ${Number(w)} ${Number(port)} ${host(target, true)}`;
    }
    case "TXT": {
      const strings = value.trimStart().startsWith('"') ? parseQuoted(value) : [value];
      const chunks: string[] = [];
      for (const s of strings) {
        for (let i = 0; i < Math.max(1, s.length); i += 255) chunks.push(s.slice(i, i + 255));
      }
      return chunks.map(quote).join(" ");
    }
    case "CAA": {
      const m = /^(\d{1,3})\s+([A-Za-z0-9]+)\s+(.*)$/s.exec(value.trim());
      if (!m) return fail("DNS_VALUE_INVALID", "CAA");
      const raw = m[3] ?? "";
      const inner = raw.startsWith('"') ? (parseQuoted(raw)[0] ?? "") : raw;
      return `${m[1]} ${(m[2] ?? "").toLowerCase()} ${quote(inner)}`;
    }
    default:
      return value.trim();
  }
}

export class FakeLazcoDns {
  readonly zoneId: string;
  readonly zoneName: string;
  readonly token: string;
  version = 1;
  maxRrsets = 500;
  dailyLimit = 90;
  /** UTC 日期 → 已套用的批次數（失敗也算的部分這裡簡化為只算套用的） */
  readonly daily = new Map<string, number>();
  readonly rrsets = new Map<string, FakeRrset>();
  readonly calls: { method: string; path: string; ifMatch: string | null; body?: unknown }[] = [];
  /** 送到 PATCH 的值只要包含這些字串就以 422 拒絕（模擬 Dev-in 沒預料到的驗證規則） */
  readonly rejectValues = new Set<string>();
  forbidden = false;
  readonly #faults: Fault[] = [];
  readonly #now: () => Date;

  constructor(opts: { zoneId?: string; zoneName?: string; token?: string; now?: () => Date } = {}) {
    this.zoneId = opts.zoneId ?? "zone-devin";
    this.zoneName = opts.zoneName ?? "dev-in.tw";
    this.token = opts.token ?? "lz_live_test_token";
    this.#now = opts.now ?? (() => new Date());
    this.rrsets.set(`${this.zoneName}.|NS`, {
      name: `${this.zoneName}.`,
      type: "NS",
      ttl: 3600,
      values: ["ns1.lazco.net.", "ns2.lazco.net."],
    });
  }

  /** 下一次（或接下來幾次）PATCH 套用這個故障 */
  fail(fault: Fault, times = 1): void {
    for (let i = 0; i < times; i++) this.#faults.push(fault);
  }

  /** 直接放一個 RRset（管理員在 Lazco 面板手動建立的紀錄） */
  seed(name: string, type: string, values: string[], ttl = 300): void {
    const fqdn = host(name, false);
    this.rrsets.set(`${fqdn}|${type}`, {
      name: fqdn,
      type,
      ttl,
      values: values.map((v) => canonical(type, v)),
    });
    this.version++;
  }

  get(name: string, type: string): FakeRrset | undefined {
    return this.rrsets.get(`${host(name, false)}|${type}`);
  }

  get patches(): number {
    return this.calls.filter((c) => c.method === "PATCH").length;
  }

  usedToday(): number {
    return this.daily.get(this.#now().toISOString().slice(0, 10)) ?? 0;
  }

  setUsedToday(n: number): void {
    this.daily.set(this.#now().toISOString().slice(0, 10), n);
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path: url.pathname, ifMatch: headers.get("if-match"), body });
    return this.#handle(method, url.pathname, headers, body);
  };

  #json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...extra },
    });
  }

  #error(
    status: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Response {
    return this.#json(
      status,
      { error: message, code, timestamp: this.#now().toISOString(), message, ...extra },
      headers,
    );
  }

  #etag(): Record<string, string> {
    return { etag: `"${this.version}"` };
  }

  #count(): number {
    return [...this.rrsets.values()].filter(
      (r) => !(r.name === `${this.zoneName}.` && (r.type === "NS" || r.type === "SOA")),
    ).length;
  }

  #zoneView() {
    return {
      id: this.zoneId,
      name: `${this.zoneName}.`,
      status: "active",
      lifecycle: "live",
      servingState: "serving",
      version: this.version,
      rrsetCount: this.#count(),
      limits: { maxRrsets: this.maxRrsets },
    };
  }

  #handle(method: string, path: string, headers: Headers, body: unknown): Response {
    if (headers.get("authorization") !== `Bearer ${this.token}`) {
      return this.#error(401, "UNAUTHORIZED", "Unauthorized");
    }
    if (this.forbidden) return this.#error(403, "FORBIDDEN_ZONE", "token cannot reach this zone");
    const base = `/v1/dns/zones/${this.zoneId}`;
    if (!path.startsWith(base)) return this.#error(404, "NOT_FOUND", "the zone does not exist");
    if (method === "GET" && path === base) return this.#json(200, this.#zoneView(), this.#etag());
    if (method === "GET" && path === `${base}/rrsets`) {
      return this.#json(
        200,
        {
          zoneId: this.zoneId,
          version: this.version,
          rrsets: [...this.rrsets.values()]
            .map((r) => ({
              name: r.name,
              type: r.type,
              ttl: r.ttl,
              records: r.values.map((value) => ({ value })),
              managed: r.name === `${this.zoneName}.` && r.type === "NS",
              setIdentifier: null,
              routing: null,
            }))
            .sort((a, b) =>
              a.name === b.name ? a.type.localeCompare(b.type) : a.name.localeCompare(b.name),
            ),
        },
        this.#etag(),
      );
    }
    if (method === "PATCH" && path === `${base}/rrsets`) return this.#patch(headers, body);
    return this.#error(404, "NOT_FOUND", "Resource not found");
  }

  #patch(headers: Headers, body: unknown): Response {
    const ifMatch = headers.get("if-match");
    if (ifMatch === null || ifMatch.trim() === "") {
      return this.#error(428, "PRECONDITION_REQUIRED", "Send If-Match with the zone version");
    }
    const raw = (body as { rrsets?: unknown } | undefined)?.rrsets;
    if (!Array.isArray(raw)) return this.#error(400, "VALIDATION_ERROR", "rrsets must be a list");

    const fault = this.#faults.shift();
    if (fault?.kind === "in_progress") {
      return this.#error(
        409,
        "DNS_CHANGE_IN_PROGRESS",
        "another change is being applied",
        {},
        {
          "retry-after": "2",
        },
      );
    }
    if (fault?.kind === "rate_limited") {
      return this.#json(
        429,
        {
          error: "Rate limit exceeded.",
          code: "RATE_LIMITED",
          timestamp: this.#now().toISOString(),
        },
        { "retry-after": String(fault.retryAfter) },
      );
    }
    if (fault?.kind === "unavailable") {
      return this.#error(503, "DNS_UNAVAILABLE", "try again shortly", {}, { "retry-after": "30" });
    }
    if (fault?.kind === "status") return this.#error(fault.status, fault.code, fault.code);
    if (fault?.kind === "concurrent") {
      fault.apply?.(this);
      this.version++;
    }

    // 1. 每個變更本身
    const issues: { index: number; code: string; message: string }[] = [];
    if (raw.length > 100) {
      return this.#error(422, "DNS_BATCH_TOO_LARGE", "at most 100 changes", {
        issues: [{ index: -1, code: "DNS_BATCH_TOO_LARGE", message: "at most 100 changes" }],
      });
    }
    const seen = new Set<string>();
    type Change = {
      action: "REPLACE" | "DELETE";
      key: string;
      rrset?: FakeRrset;
      expected?: string[];
    };
    const changes: Change[] = [];
    raw.forEach((entry, index) => {
      try {
        const e = entry as Record<string, unknown>;
        if (e.action !== "REPLACE" && e.action !== "DELETE") fail("DNS_VALUE_INVALID", "action");
        const name = host(String(e.name ?? ""), false);
        const bare = name.slice(0, -1);
        if (bare !== this.zoneName && !bare.endsWith(`.${this.zoneName}`)) {
          fail("DNS_NAME_OUT_OF_ZONE", "out of zone");
        }
        if (!bare.split(".").every((l) => OWNER.test(l))) fail("DNS_NAME_INVALID", "label");
        if (bare.split(".").includes("_lazco-verify")) fail("DNS_RESERVED_LABEL", "reserved");
        const type = String(e.type ?? "").toUpperCase();
        if (!WRITABLE.has(type)) fail("DNS_RECORD_TYPE_UNSUPPORTED", type);
        if (name === `${this.zoneName}.` && (type === "NS" || type === "SOA")) {
          fail("DNS_APEX_MANAGED", "apex managed");
        }
        const key = `${name}|${type}`;
        if (seen.has(key)) fail("DNS_DUPLICATE_RRSET", `${key} twice`);
        seen.add(key);
        if (e.action === "DELETE") {
          if (e.records !== undefined || e.ttl !== undefined) fail("DNS_VALUE_INVALID", "DELETE");
          const expected = Array.isArray(e.expectedRecords)
            ? (e.expectedRecords as { value: string }[]).map((r) => canonical(type, r.value))
            : undefined;
          changes.push({ action: "DELETE", key, ...(expected ? { expected } : {}) });
          return;
        }
        const ttl = e.ttl;
        if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) {
          fail("DNS_TTL_OUT_OF_RANGE", "ttl");
        }
        if (type === "CNAME" && name === `${this.zoneName}.`) fail("DNS_CNAME_AT_APEX", "apex");
        const records = e.records as { value: string }[] | undefined;
        if (!Array.isArray(records) || records.length === 0 || records.length > 100) {
          fail("DNS_VALUE_INVALID", "records");
        }
        const values: string[] = [];
        for (const r of records ?? []) {
          if ([...this.rejectValues].some((bad) => r.value.includes(bad))) {
            fail("DNS_VALUE_INVALID", `value ${r.value} is refused`);
          }
          const value = canonical(type, r.value);
          if (values.includes(value)) fail("DNS_DUPLICATE_RECORD", "twice");
          values.push(value);
        }
        if (type === "CNAME" && values.length !== 1) fail("DNS_VALUE_INVALID", "one CNAME");
        changes.push({ action: "REPLACE", key, rrset: { name, type, ttl: ttl as number, values } });
      } catch (error) {
        if (!(error instanceof Issue)) throw error;
        issues.push({ index, code: error.code, message: error.message });
      }
    });
    if (issues.length > 0) {
      const first = issues[0] as { code: string; message: string };
      return this.#error(422, first.code, first.message, { issues });
    }

    // 2. zone 層級（鎖住 zone 之後）
    const match = /^"(\d{1,15})"$/.exec(ifMatch.trim());
    if (!match || Number(match[1]) !== this.version) {
      return this.#error(412, "DNS_VERSION_MISMATCH", "the zone changed since that version", {
        version: this.version,
      });
    }
    if (this.usedToday() >= this.dailyLimit) {
      return this.#error(
        429,
        "DNS_DAILY_CHANGE_LIMIT",
        `the zone took ${this.dailyLimit} change batches today (UTC), the daily limit`,
      );
    }
    const next = new Map(this.rrsets);
    const touchedNames = new Set<string>();
    const zoneIssues: { index: number; code: string; message: string }[] = [];
    changes.forEach((c, index) => {
      const existing = next.get(c.key);
      touchedNames.add(c.key.split("|")[0] as string);
      if (c.action === "DELETE") {
        if (c.expected) {
          const a = [...(existing?.values ?? [])].sort();
          const b = [...c.expected].sort();
          if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
            zoneIssues.push({ index, code: "DNS_VERSION_MISMATCH", message: "no longer holds" });
          }
        }
        next.delete(c.key);
      } else if (c.rrset) next.set(c.key, c.rrset);
    });
    if (zoneIssues.length > 0) {
      return this.#error(412, "DNS_VERSION_MISMATCH", "the records changed", {
        issues: zoneIssues,
        version: this.version,
      });
    }
    const types = new Map<string, Set<string>>();
    for (const r of next.values()) {
      const set = types.get(r.name) ?? new Set<string>();
      set.add(r.type);
      types.set(r.name, set);
    }
    changes.forEach((c, index) => {
      const name = c.key.split("|")[0] as string;
      const set = types.get(name);
      if (set?.has("CNAME") && set.size > 1) {
        zoneIssues.push({
          index,
          code: "DNS_CNAME_CONFLICT",
          message: `${name} has a CNAME beside other types`,
        });
      }
    });
    const count = [...next.values()].filter(
      (r) => !(r.name === `${this.zoneName}.` && (r.type === "NS" || r.type === "SOA")),
    ).length;
    if (count > this.maxRrsets && count > this.#count()) {
      zoneIssues.push({ index: -1, code: "DNS_RRSET_LIMIT_REACHED", message: "above the limit" });
    }
    if (zoneIssues.length > 0) {
      const first = zoneIssues[0] as { code: string; message: string };
      return this.#error(422, first.code, first.message, { issues: zoneIssues });
    }

    // 3. 套用
    this.rrsets.clear();
    for (const [k, v] of next) this.rrsets.set(k, v);
    this.version++;
    this.setUsedToday(this.usedToday() + 1);
    if (fault?.kind === "outcome_unknown") {
      return this.#error(504, "DNS_OUTCOME_UNKNOWN", "the change may or may not have been applied");
    }
    const status = fault?.kind === "pending" ? 202 : 200;
    return this.#json(
      status,
      {
        version: this.version,
        changeId: `change-${this.version}`,
        status: status === 202 ? "pending" : "applied",
        zone: this.#zoneView(),
      },
      this.#etag(),
    );
  }
}

export const nextUtcDay = (now: Date): Date =>
  new Date(Math.floor(now.getTime() / DAY) * DAY + DAY);
