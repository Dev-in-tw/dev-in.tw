import { expect, test } from "@playwright/test";

/**
 * 搬到 Lazco DNS 之後，www.dev-in.tw 與 api.dev-in.tw 直接由 Traefik 送到 web（沒有 Cloudflare 幫忙轉址）。
 * 直接打 next start（:3100），以 Host header 模擬這兩個 host，驗證 proxy 的 matcher 在 production build
 * 中真的涵蓋每一個路徑（包含 /api 與靜態檔）。
 */
const WEB = "http://localhost:3100";

test("www.dev-in.tw redirects permanently to the apex, keeping the path", async ({ request }) => {
  for (const path of ["/", "/docs/faq?x=1", "/favicon.ico"]) {
    const res = await request.get(`${WEB}${path}`, {
      headers: { host: "www.dev-in.tw" },
      maxRedirects: 0,
    });
    expect(res.status(), path).toBe(301);
    expect(res.headers().location, path).toBe(`https://dev-in.tw${path}`);
  }
});

test("api.dev-in.tw redirects every path to the API docs", async ({ request }) => {
  for (const path of ["/", "/v1/meta", "/api/v1/meta", "/_next/static/x.js"]) {
    const res = await request.get(`${WEB}${path}`, {
      headers: { host: "api.dev-in.tw" },
      maxRedirects: 0,
    });
    expect(res.status(), path).toBe(302);
    expect(res.headers().location, path).toBe("https://dev-in.tw/api/docs");
  }
});

test("the apex itself is not redirected", async ({ request }) => {
  const res = await request.get(`${WEB}/docs`, { headers: { host: "dev-in.tw" }, maxRedirects: 0 });
  expect(res.status()).toBe(200);
});
