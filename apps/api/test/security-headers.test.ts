import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_CSP, DOCS_CSP } from "../src/http/middleware/core.ts";
import { login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

/** 2026-10 安全稽核（docs/security/AUDIT-2026-10.md）的回歸測試：API 安全標頭與 /api/docs sandbox */

describe.skipIf(!pgAvailable)("api security headers", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(() => t.close());

  describe("security headers", () => {
    it("sends a deny-all CSP, COOP, CORP, nosniff and HSTS without includeSubDomains", async () => {
      const res = await request(t, "GET", "/api/v1/meta");
      expect(res.headers.get("content-security-policy")).toBe(API_CSP);
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      const hsts = res.headers.get("strict-transport-security") ?? "";
      expect(hsts).toMatch(/^max-age=\d+$/);
      expect(hsts).not.toMatch(/includesubdomains|preload/i);
    });

    it("never lets authenticated or error responses be cached", async () => {
      const cookie = await login(t, "hdr-alice");
      for (const res of [
        await request(t, "GET", "/api/v1/me", { cookie }),
        await request(t, "GET", "/api/v1/me"),
        await request(t, "GET", "/api/v1/does-not-exist"),
      ]) {
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-security-policy")).toBe(API_CSP);
      }
    });

    it("sandboxes /api/docs into an opaque origin and pins the Scalar bundle", async () => {
      const res = await request(t, "GET", "/api/docs");
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toBe(DOCS_CSP);
      expect(csp).toMatch(/(^|;\s*)sandbox allow-scripts/);
      expect(csp).not.toContain("allow-same-origin");
      const html = await res.text();
      expect(html).toMatch(/cdn\.jsdelivr\.net\/npm\/@scalar\/api-reference@\d+\.\d+\.\d+/);
      // sandbox 裡沒有 Web Storage：shim 必須在 Scalar 之前載入
      expect(html.indexOf("Object.defineProperty(window,n")).toBeGreaterThan(-1);
      expect(html.indexOf("Object.defineProperty(window,n")).toBeLessThan(
        html.indexOf("cdn.jsdelivr.net"),
      );
      const spec = await request(t, "GET", "/api/openapi.json");
      expect(spec.headers.get("access-control-allow-origin")).toBe("*");
      expect(spec.headers.get("access-control-allow-credentials")).toBeNull();
    });
  });
});
