import { expect, loginAs, test } from "./fixtures.ts";

/**
 * 2026-10 安全稽核：網站的安全標頭（docs/security/AUDIT-2026-10.md）。
 * HSTS 刻意不帶 includeSubDomains / preload：使用者子網域不一定有 HTTPS（PLAN §6 Q14）。
 */

const EXPECTED = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

test("marketing, auth and signed-in pages share the hardened header set", async ({ page }) => {
  await loginAs(page);
  for (const path of ["/", "/login", "/docs", "/dashboard"]) {
    const res = await page.goto(path);
    const headers = res?.headers() ?? {};
    for (const [name, value] of Object.entries(EXPECTED)) {
      expect(headers[name], `${name} on ${path}`).toBe(value);
    }
    const hsts = headers["strict-transport-security"] ?? "";
    expect(hsts).toMatch(/^max-age=\d{8,}$/);
    expect(hsts.toLowerCase()).not.toContain("includesubdomains");
    expect(hsts.toLowerCase()).not.toContain("preload");
    const permissions = headers["permissions-policy"] ?? "";
    expect(permissions).toContain("camera=()");
    expect(permissions).toContain("browsing-topics=()");
    expect(permissions).not.toContain("interest-cohort");
    const csp = headers["content-security-policy"] ?? "";
    for (const directive of ["frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'"]) {
      expect(csp, `${directive} on ${path}`).toContain(directive);
    }
  }
});

test("signed-in pages are never stored by shared caches", async ({ page }) => {
  await loginAs(page);
  const res = await page.goto("/dashboard");
  expect(res?.headers()["cache-control"]).toContain("no-store");
});

test("the social preview image can be embedded cross-origin", async ({ request }) => {
  const res = await request.get("/opengraph-image");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["cross-origin-resource-policy"]).toBe("cross-origin");
});
