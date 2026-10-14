import { type Client, createClient, type EndpointName, type RequestOf } from "@dit/contract";
import { DiscordNotifier } from "../../src/adapters/discord/notifier.ts";
import type { DohResolver } from "../../src/adapters/doh/client.ts";
import type { GithubClient, GithubIdentity } from "../../src/adapters/github/client.ts";
import { MemoryDnsProvider } from "../../src/adapters/memory-dns/provider.ts";
import { createDeps } from "../../src/bootstrap.ts";
import { type Config, loadConfig } from "../../src/config.ts";
import type { Deps } from "../../src/context.ts";
import { seedReservedNames } from "../../src/db/seed.ts";
import { type AppOptions, createApp } from "../../src/http/app.ts";
import { RateLimiter } from "../../src/http/middleware/rate-limit.ts";
import { ManualClock } from "../../src/lib/clock.ts";
import { createLogger, silentLogger } from "../../src/lib/logger.ts";
import { SyncWorker } from "../../src/sync/worker.ts";
import { createTestDatabase } from "./db.ts";

export const ORIGIN = "https://dev-in.tw";

export function testEnv(
  databaseUrl: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    GITHUB_REDIRECT_URI: `${ORIGIN}/api/v1/auth/github/callback`,
    ADMIN_GITHUB_IDS: "51485352",
    ROOT_DOMAIN: "dev-in.tw",
    ZONE_RECORD_LIMIT: "1000",
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    REPORT_IP_SALT: "test-report-salt",
    AUTH_DEV_LOGIN: "true",
    WORKER_ENABLED: "false",
    LOG_LEVEL: "silent",
    ...overrides,
  };
}

/** 測試用的 GitHub：code → 身分 */
export class FakeGithub implements GithubClient {
  readonly identities = new Map<string, GithubIdentity>();
  readonly calls: { code: string; codeVerifier: string; redirectUri: string }[] = [];
  async exchange(input: { code: string; codeVerifier: string; redirectUri: string }) {
    this.calls.push(input);
    const identity = this.identities.get(input.code);
    if (!identity) throw new Error("bad code");
    return identity;
  }
}

export class FakeDoh implements DohResolver {
  answers = new Map<string, string[]>();
  /** "<resolver>|<fqdn>" 或 "*|<fqdn>"：回 NXDOMAIN */
  nxdomain = new Set<string>();
  calls = 0;
  async query(resolver: string, fqdn: string, type: string) {
    this.calls++;
    if (this.nxdomain.has(`${resolver}|${fqdn}`) || this.nxdomain.has(`*|${fqdn}`))
      return { answers: [], latencyMs: 12, error: null, nxdomain: true };
    if (resolver === "quad101" && fqdn.startsWith("slow."))
      return { answers: [], latencyMs: null, error: "逾時" };
    return { answers: this.answers.get(`${fqdn}|${type}`) ?? [], latencyMs: 12, error: null };
  }
}

export interface TestContext {
  config: Config;
  deps: Deps;
  app: ReturnType<typeof createApp>;
  provider: MemoryDnsProvider;
  clock: ManualClock;
  notifier: DiscordNotifier;
  github: FakeGithub;
  doh: FakeDoh;
  worker: SyncWorker;
  limiter: RateLimiter;
  close(): Promise<void>;
}

export async function setupTestApp(
  opts: {
    env?: Record<string, string>;
    seed?: boolean;
    app?: AppOptions;
    logger?: ReturnType<typeof createLogger>;
  } = {},
): Promise<TestContext> {
  const database = await createTestDatabase();
  const config = loadConfig(testEnv(database.url, opts.env));
  const clock = new ManualClock(new Date());
  const provider = new MemoryDnsProvider({
    zoneName: config.ROOT_DOMAIN,
    recordLimit: config.ZONE_RECORD_LIMIT,
  });
  const notifier = new DiscordNotifier({
    webhookUrl: undefined,
    logger: silentLogger,
    throttleMs: 0,
  });
  const github = new FakeGithub();
  const doh = new FakeDoh();
  const logger =
    opts.logger ?? (process.env.TEST_LOG ? createLogger(process.env.TEST_LOG) : silentLogger);
  const deps = createDeps(config, database, logger, {
    provider,
    clock,
    notifier,
    github,
    doh,
    turnstile: { verify: async (token) => token === "pass" },
  });
  if (opts.seed !== false) await seedReservedNames(deps.db);
  await deps.bus.start(deps.sql);
  const limiter = new RateLimiter(() => clock.now().getTime());
  const app = createApp(deps, {
    limiter,
    validateResponses: true,
    ssePingMs: 1000,
    ...opts.app,
  });
  const worker = new SyncWorker(deps);
  return {
    config,
    deps,
    app,
    provider,
    clock,
    notifier,
    github,
    doh,
    worker,
    limiter,
    async close() {
      deps.runtime.stopping = true;
      await Promise.allSettled([...deps.runtime.background]);
      await deps.bus.stop();
      await database.drop();
    },
  };
}

export interface RequestOptions {
  body?: unknown;
  rawBody?: string;
  cookie?: string | undefined;
  headers?: Record<string, string>;
  origin?: string | null;
  secFetchSite?: string | null;
  ip?: string;
}

let ipCounter = 0;
/** 每個請求預設用不同的 IP，避免 IP 限流干擾一般測試（限流測試會明確指定 ip） */
export function nextIp(): string {
  ipCounter++;
  return `100.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

/** 模擬瀏覽器的同源請求（Origin、Sec-Fetch-Site、JSON body） */
export async function request(
  t: TestContext,
  method: string,
  path: string,
  opts: RequestOptions = {},
) {
  const headers = new Headers(opts.headers);
  if (method !== "GET" && opts.origin !== null) headers.set("Origin", opts.origin ?? ORIGIN);
  if (opts.secFetchSite !== null) headers.set("Sec-Fetch-Site", opts.secFetchSite ?? "same-origin");
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  headers.set("X-Forwarded-For", opts.ip ?? nextIp());
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  if (body !== undefined) headers.set("Content-Length", String(Buffer.byteLength(body)));
  const url = path.startsWith("http") ? path : `http://localhost${path}`;
  return t.app.request(
    url,
    { method, headers, ...(body !== undefined ? { body } : {}) },
    {
      incoming: { socket: { remoteAddress: "10.0.0.2" } },
    },
  );
}

/** dev 登入，回傳 Cookie header 值 */
export async function login(
  t: TestContext,
  githubLogin: string,
  opts: { role?: "user" | "admin"; githubAgeDays?: number; ip?: string } = {},
): Promise<string> {
  const res = await request(t, "POST", "/api/v1/auth/dev-login", {
    body: { githubLogin, role: opts.role ?? "user", githubAgeDays: opts.githubAgeDays ?? 365 },
    ...(opts.ip ? { ip: opts.ip } : {}),
  });
  if (res.status !== 204) throw new Error(`dev login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

/** 合約的 typed client（validateResponses: true），請求經過完整的中介層 */
export function contractClient(t: TestContext, cookie?: string): Client {
  return createClient({
    baseUrl: "http://localhost/api/v1",
    validateResponses: true,
    headers: () => ({
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "X-Forwarded-For": nextIp(),
      ...(cookie ? { Cookie: cookie } : {}),
    }),
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (init?.body !== undefined && init.body !== null) {
        headers.set("Content-Length", String(Buffer.byteLength(String(init.body))));
      }
      return t.app.request(
        String(input),
        { ...init, headers },
        { incoming: { socket: { remoteAddress: "10.0.0.2" } } },
      );
    },
  });
}

export type Call = <N extends EndpointName>(name: N, req?: RequestOf<N>) => ReturnType<Client>;

/** 從回應取出某個 Set-Cookie 的 name=value */
export function cookieFrom(res: Response, name: string): string {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const found = all.find((c) => c.startsWith(`${name}=`)) ?? "";
  return found.split(";")[0] ?? "";
}

/**
 * 走一次 GitHub OAuth（FakeGithub）：start → callback，回傳 session cookie。
 * query 是 start 的額外參數（例如登入頁帶上的條款版本）。
 */
export async function githubLogin(
  t: TestContext,
  identity: GithubIdentity,
  query: Record<string, string> = {},
): Promise<string> {
  const code = `code-${identity.id}-${Math.random().toString(36).slice(2)}`;
  t.github.identities.set(code, identity);
  const qs = new URLSearchParams(query).toString();
  const start = await request(t, "GET", `/api/v1/auth/github/start${qs ? `?${qs}` : ""}`);
  const state = new URL(start.headers.get("location") as string).searchParams.get("state");
  const oauth = cookieFrom(start, "__Host-dit_oauth");
  const cb = await request(t, "GET", `/api/v1/auth/github/callback?code=${code}&state=${state}`, {
    cookie: oauth,
  });
  const session = cookieFrom(cb, "__Host-dit_session");
  if (!session) throw new Error(`github login failed: ${cb.headers.get("location")}`);
  return session;
}

/** 建立一個 active 的子網域（含 Turnstile 通過） */
export async function claim(t: TestContext, cookie: string, name: string) {
  const res = await request(t, "POST", "/api/v1/subdomains", {
    cookie,
    body: { name, description: "", acceptTerms: true, turnstileToken: "pass" },
  });
  if (res.status !== 201)
    throw new Error(`claim ${name} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ name: string; status: string }>;
}
