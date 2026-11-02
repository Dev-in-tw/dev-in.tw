import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import { testEnv } from "./helpers/app.ts";

const base = (o: Record<string, string> = {}) =>
  testEnv("postgres://dit:dit@127.0.0.1:5432/dit", o);
const prod = (o: Record<string, string> = {}) =>
  base({
    NODE_ENV: "production",
    AUTH_DEV_LOGIN: "false",
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ZONE_ID: "zone-id",
    TURNSTILE_SECRET_KEY: "0x4AAAAAAA-real-secret",
    ...o,
  });

describe("config", () => {
  it("accepts the test environment and applies the owner decisions as defaults", () => {
    const config = loadConfig(base());
    expect(config.MAX_SUBDOMAINS_PER_USER).toBe(2);
    expect(config.MAX_RECORDS_PER_SUBDOMAIN).toBe(10);
    expect(config.ADMIN_GITHUB_IDS).toEqual([51485352]);
    expect(config.SYSTEM_RECORD_NAMES).toEqual(["@", "www", "api", "_dmarc", "_psl", "mail"]);
    expect(config.TURNSTILE_EXPECTED_HOSTNAME).toBe("dev-in.tw");
    expect(config.TURNSTILE_IS_TEST_KEY).toBe(true);
  });

  it("defaults DNS_PROVIDER to memory outside production and cloudflare in production", () => {
    expect(loadConfig(base()).DNS_PROVIDER).toBe("memory");
    expect(loadConfig(prod()).DNS_PROVIDER).toBe("cloudflare");
  });

  it("refuses to start with dev login in production", () => {
    expect(() => loadConfig(prod({ AUTH_DEV_LOGIN: "true" }))).toThrow(/AUTH_DEV_LOGIN/);
  });

  it("refuses to disable rate limiting in production but allows it for local e2e", () => {
    expect(() => loadConfig(prod({ RATE_LIMIT_ENABLED: "false" }))).toThrow(/RATE_LIMIT_ENABLED/);
    expect(loadConfig(base({ RATE_LIMIT_ENABLED: "false" })).RATE_LIMIT_ENABLED).toBe(false);
  });

  it("refuses cloudflare together with dev login", () => {
    expect(() =>
      loadConfig(
        base({ DNS_PROVIDER: "cloudflare", CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ZONE_ID: "z" }),
      ),
    ).toThrow(/DNS_PROVIDER=cloudflare 不可搭配 AUTH_DEV_LOGIN/);
  });

  it("requires cloudflare credentials, GitHub OAuth and real Turnstile keys in production", () => {
    expect(() => loadConfig(prod({ CLOUDFLARE_API_TOKEN: "" }))).toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(() => loadConfig(prod({ GITHUB_CLIENT_SECRET: "" }))).toThrow(/GITHUB_CLIENT_SECRET/);
    expect(() =>
      loadConfig(prod({ TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" })),
    ).toThrow(/測試金鑰/);
    expect(() => loadConfig(prod({ APP_ORIGIN: "http://dev-in.tw" }))).toThrow(/https/);
  });

  it("validates the Lazco DNS settings and refuses to start without them in production", () => {
    const lazco = (o: Record<string, string> = {}) =>
      prod({
        DNS_PROVIDER: "lazco",
        LAZCO_DNS_TOKEN: "lz_live_token",
        LAZCO_DNS_ZONE_ID: "zone-devin",
        ...o,
      });
    const config = loadConfig(lazco());
    expect(config).toMatchObject({
      DNS_PROVIDER: "lazco",
      LAZCO_DNS_API_URL: "https://api.lazco.tw",
      LAZCO_DNS_DAILY_BATCH_BUDGET: 80,
      LAZCO_DNS_MIN_BATCH_INTERVAL_SECONDS: 60,
    });
    expect(() => loadConfig(lazco({ LAZCO_DNS_TOKEN: "" }))).toThrow(/LAZCO_DNS_TOKEN/);
    expect(() => loadConfig(lazco({ LAZCO_DNS_ZONE_ID: "" }))).toThrow(/LAZCO_DNS_ZONE_ID/);
    expect(() => loadConfig(lazco({ LAZCO_DNS_API_URL: "http://api.lazco.tw" }))).toThrow(
      /LAZCO_DNS_API_URL/,
    );
    // 0：zone 在 Lazco DNS 的 epoch serial 模式，沒有每日額度
    expect(
      loadConfig(lazco({ LAZCO_DNS_DAILY_BATCH_BUDGET: "0" })).LAZCO_DNS_DAILY_BATCH_BUDGET,
    ).toBe(0);
    // Lazco DNS 每天 90 批：Dev-in 一定要留餘裕
    expect(() => loadConfig(lazco({ LAZCO_DNS_DAILY_BATCH_BUDGET: "90" }))).toThrow(
      /LAZCO_DNS_DAILY_BATCH_BUDGET/,
    );
    expect(() =>
      loadConfig(base({ DNS_PROVIDER: "lazco", LAZCO_DNS_TOKEN: "t", LAZCO_DNS_ZONE_ID: "z" })),
    ).toThrow(/DNS_PROVIDER=lazco 不可搭配 AUTH_DEV_LOGIN/);
    // Cloudflare 的變數在 lazco 時不必填
    expect(loadConfig(lazco({ CLOUDFLARE_API_TOKEN: "" })).DNS_PROVIDER).toBe("lazco");
  });

  it("does not trust CF-Connecting-IP unless TRUST_CLOUDFLARE is set", () => {
    expect(loadConfig(base()).TRUST_CLOUDFLARE).toBe(false);
    expect(loadConfig(prod()).TRUST_CLOUDFLARE).toBe(false);
  });

  it("lists every missing variable with a clear error", () => {
    const error = (() => {
      try {
        loadConfig({ NODE_ENV: "production" });
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(ConfigError);
    for (const key of [
      "APP_ORIGIN",
      "DATABASE_URL",
      "SESSION_SECRET",
      "ADMIN_GITHUB_IDS",
      "ZONE_RECORD_LIMIT",
      "REPORT_IP_SALT",
    ]) {
      expect(error?.message).toContain(key);
    }
  });

  it("validates formats", () => {
    expect(() => loadConfig(base({ SESSION_SECRET: "short" }))).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig(base({ ADMIN_GITHUB_IDS: "haco" }))).toThrow(/ADMIN_GITHUB_IDS/);
    expect(() => loadConfig(base({ APP_ORIGIN: "https://dev-in.tw/app" }))).toThrow(/origin/);
    expect(() => loadConfig(base({ ZONE_HEADROOM: "5000" }))).toThrow(/ZONE_HEADROOM/);
    expect(() => loadConfig(base({ ALLOWED_RECORD_TYPES: "A,NS" }))).toThrow(
      /ALLOWED_RECORD_TYPES/,
    );
  });
});
