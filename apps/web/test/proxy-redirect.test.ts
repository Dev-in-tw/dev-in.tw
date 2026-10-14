import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, hostRedirect, proxy } from "../proxy.ts";

const req = (url: string, host?: string) =>
  new NextRequest(url, host ? { headers: { host } } : undefined);

describe("host redirects", () => {
  it("sends www.dev-in.tw to the apex with a 301, keeping the path and query", async () => {
    const res = await proxy(req("https://www.dev-in.tw/docs/faq?x=1#top", "www.dev-in.tw"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://dev-in.tw/docs/faq?x=1");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=63072000");
    expect(res.headers.get("strict-transport-security")).not.toMatch(/includeSubDomains/i);
  });

  it("sends every path of api.dev-in.tw to the API docs with a 302", async () => {
    for (const path of ["/", "/v1/meta", "/api/v1/meta", "/anything?q=1"]) {
      const res = await proxy(req(`https://api.dev-in.tw${path}`, "api.dev-in.tw"));
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe("https://dev-in.tw/api/docs");
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
  });

  it("matches the host case-insensitively and ignores the port", () => {
    expect(hostRedirect(req("http://localhost/", "WWW.Dev-In.TW:443"))?.status).toBe(301);
    expect(hostRedirect(req("http://localhost/", "api.dev-in.tw:80"))?.status).toBe(302);
  });

  it("never redirects other hosts, so a forged Host cannot point anywhere else", async () => {
    for (const host of [
      "dev-in.tw",
      "localhost:3000",
      "alice.dev-in.tw",
      "www.evil.example",
      "www.dev-in.tw.evil.example",
      "api.dev-in.tw.evil.example",
      "[::1]:3000",
    ]) {
      expect(hostRedirect(req("http://localhost/docs", host)), host).toBeNull();
    }
    const res = await proxy(req("https://dev-in.tw/", "dev-in.tw"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("runs the proxy on every path of the www and api hosts", () => {
    const [hosts] = config.matcher;
    expect(hosts).toEqual({
      source: "/:path*",
      has: [{ type: "host", value: "(?:www|api)\\.dev-in\\.tw" }],
    });
    const pattern = new RegExp(`^${hosts?.has?.[0]?.value}$`);
    expect(pattern.test("www.dev-in.tw")).toBe(true);
    expect(pattern.test("api.dev-in.tw")).toBe(true);
    expect(pattern.test("wwwxdev-in.tw")).toBe(false);
    expect(pattern.test("dev-in.tw")).toBe(false);
  });
});
