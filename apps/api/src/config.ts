import { RecordType } from "@dit/contract";
import { z } from "zod";

/**
 * 環境變數驗證（docs/PLAN.md §3.13 與 §7）。缺值、格式錯誤或危險組合時直接啟動失敗，
 * 錯誤訊息會列出每一個有問題的變數。
 */

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : v === "true" || v === "1"));

const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

const TURNSTILE_TEST_SECRET = /^[123]x0{30,}A{2}$/;

const Env = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: int(3001, 1, 65_535),
    HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    APP_ORIGIN: z.url().transform((v, ctx) => {
      const url = new URL(v);
      if (url.origin !== v.replace(/\/+$/, "")) {
        ctx.addIssue({
          code: "custom",
          message: "必須只有 origin（例如 https://dev-in.tw），不可帶路徑",
        });
      }
      return url.origin;
    }),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "必須是 postgres:// 連線字串"),
    SESSION_SECRET: z.string().min(32, "至少 32 個字元的亂數"),

    GITHUB_CLIENT_ID: optionalString,
    GITHUB_CLIENT_SECRET: optionalString,
    GITHUB_REDIRECT_URI: optionalString.pipe(z.url().optional()),
    ADMIN_GITHUB_IDS: z
      .string()
      .regex(/^\s*\d+(\s*,\s*\d+)*\s*$/, "以逗號分隔的 GitHub numeric id")
      .transform((v) => v.split(",").map((s) => Number(s.trim()))),

    ROOT_DOMAIN: z
      .string()
      .regex(
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
        "小寫網域，例如 dev-in.tw",
      ),
    DNS_PROVIDER: z.enum(["memory", "cloudflare"]).optional(),
    CLOUDFLARE_API_TOKEN: optionalString,
    CLOUDFLARE_ZONE_ID: optionalString,
    CLOUDFLARE_API_BASE: z.url().default("https://api.cloudflare.com/client/v4"),
    CLOUDFLARE_RPS: z.coerce.number().positive().max(4).default(3),

    ZONE_RECORD_LIMIT: z.coerce.number().int().min(1),
    ZONE_HEADROOM: int(20),
    SYSTEM_RECORD_NAMES: csv("@,www,api,_dmarc,_psl,mail"),
    MAX_SUBDOMAINS_PER_USER: int(2),
    MAX_RECORDS_PER_SUBDOMAIN: int(10),
    MIN_GITHUB_ACCOUNT_AGE_DAYS: int(30),
    NAME_COOLDOWN_DAYS: int(30),
    ALLOWED_RECORD_TYPES: csv("A,AAAA,CNAME,TXT,MX,SRV,CAA").pipe(z.array(RecordType).min(1)),

    TURNSTILE_SITE_KEY: z.string().min(1),
    TURNSTILE_SECRET_KEY: z.string().min(1),
    TURNSTILE_EXPECTED_HOSTNAME: optionalString,
    REPORT_IP_SALT: z.string().min(8),

    TRUSTED_PROXY_HOPS: int(1, 0, 10),
    /** 前面有 Cloudflare 代理時開啟：來源是 Cloudflare 機房才改用 CF-Connecting-IP */
    TRUST_CLOUDFLARE: bool(false),
    /** 關掉限流（只給本機與 e2e 用；production 拒絕啟動） */
    RATE_LIMIT_ENABLED: bool(true),
    WORKER_ENABLED: bool(true),
    RECONCILE_INTERVAL_SECONDS: int(600, 0),
    RECONCILE_MAX_ORPHAN_DELETES: int(10),
    AUTH_DEV_LOGIN: bool(false),

    DISCORD_WEBHOOK_URL: optionalString.pipe(z.url().optional()),
    SENTRY_DSN: optionalString,
    METRICS_ENABLED: bool(false),
    METRICS_PORT: int(9464, 1, 65_535),

    RESERVED_PRIVATE_SEED_FILE: optionalString,

    PUBLIC_GITHUB_URL: z.url().default("https://github.com/Dev-in-tw"),
    PUBLIC_DISCORD_URL: optionalString.pipe(z.url().optional()),
  })
  .superRefine((env, ctx) => {
    const prod = env.NODE_ENV === "production";
    const provider = env.DNS_PROVIDER ?? (prod ? "cloudflare" : "memory");
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });

    if (prod && !env.RATE_LIMIT_ENABLED) {
      issue("RATE_LIMIT_ENABLED", "NODE_ENV=production 時不可關閉限流");
    }
    if (prod && env.AUTH_DEV_LOGIN) {
      issue("AUTH_DEV_LOGIN", "NODE_ENV=production 時不可開啟 dev 登入");
    }
    if (provider === "cloudflare" && env.AUTH_DEV_LOGIN) {
      issue("DNS_PROVIDER", "DNS_PROVIDER=cloudflare 不可搭配 AUTH_DEV_LOGIN=true");
    }
    if (provider === "cloudflare") {
      if (!env.CLOUDFLARE_API_TOKEN)
        issue("CLOUDFLARE_API_TOKEN", "DNS_PROVIDER=cloudflare 時必填");
      if (!env.CLOUDFLARE_ZONE_ID) issue("CLOUDFLARE_ZONE_ID", "DNS_PROVIDER=cloudflare 時必填");
    }
    if (!env.AUTH_DEV_LOGIN || prod) {
      for (const key of [
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
        "GITHUB_REDIRECT_URI",
      ] as const) {
        if (!env[key]) issue(key, "未開啟 AUTH_DEV_LOGIN 時必填");
      }
    }
    if (prod) {
      if (!env.APP_ORIGIN.startsWith("https://")) issue("APP_ORIGIN", "production 必須是 https");
      if (TURNSTILE_TEST_SECRET.test(env.TURNSTILE_SECRET_KEY)) {
        issue("TURNSTILE_SECRET_KEY", "production 不可使用 Turnstile 測試金鑰");
      }
      if (env.SESSION_SECRET.startsWith("change-me")) issue("SESSION_SECRET", "請換成真正的亂數");
      if (env.REPORT_IP_SALT.startsWith("change-me")) issue("REPORT_IP_SALT", "請換成真正的亂數");
    }
    if (env.ZONE_HEADROOM >= env.ZONE_RECORD_LIMIT) {
      issue("ZONE_HEADROOM", "必須小於 ZONE_RECORD_LIMIT");
    }
  })
  .transform((env) => {
    const prod = env.NODE_ENV === "production";
    return {
      ...env,
      DNS_PROVIDER: env.DNS_PROVIDER ?? (prod ? ("cloudflare" as const) : ("memory" as const)),
      TURNSTILE_EXPECTED_HOSTNAME:
        env.TURNSTILE_EXPECTED_HOSTNAME ?? new URL(env.APP_ORIGIN).hostname,
      /** Turnstile 測試金鑰回傳的 hostname 是固定值，所以測試金鑰不比對 hostname */
      TURNSTILE_IS_TEST_KEY: TURNSTILE_TEST_SECRET.test(env.TURNSTILE_SECRET_KEY),
      SYSTEM_RECORD_NAMES: env.SYSTEM_RECORD_NAMES.map((n) => n.toLowerCase()),
    };
  });

export type Config = z.output<typeof Env>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      `環境變數設定錯誤，拒絕啟動（完整清單見 apps/api/.env.example 與 docs/PLAN.md §3.13）：\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
