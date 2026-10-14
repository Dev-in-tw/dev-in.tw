import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../src/http/middleware/core.ts";
import { ORIGIN, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

/** 2026-10 安全稽核（docs/security/AUDIT-2026-10.md）的回歸測試：request body 上限 */

describe.skipIf(!pgAvailable)("request body limit", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(() => t.close());

  describe("request body limit", () => {
    it("rejects a declared body larger than the limit before parsing it", async () => {
      const res = await request(t, "POST", "/api/v1/reports", {
        rawBody: JSON.stringify({ details: "x".repeat(MAX_BODY_BYTES) }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(await res.json()).toMatchObject({
        code: "VALIDATION_FAILED",
        errors: [expect.objectContaining({ code: "too_large" })],
      });
    });

    it("rejects an oversized chunked body without Content-Length", async () => {
      const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 8) return controller.close();
          sent++;
          controller.enqueue(chunk);
        },
      });
      const res = await t.app.request(
        "http://localhost/api/v1/reports",
        {
          method: "POST",
          headers: {
            Origin: ORIGIN,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
            "X-Forwarded-For": "100.99.0.1",
          },
          body,
          duplex: "half",
        } as RequestInit,
        { incoming: { socket: { remoteAddress: "10.0.0.2" } } },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "VALIDATION_FAILED",
        errors: [expect.objectContaining({ code: "too_large" })],
      });
    });

    it("still accepts normal JSON bodies", async () => {
      const res = await request(t, "POST", "/api/v1/reports", {
        body: {
          subdomain: "nobody-here",
          category: "phishing",
          details: "這是一筆正常大小的檢舉內容。",
          turnstileToken: "pass",
        },
      });
      expect(res.status).toBe(201);
    });
  });
});
