import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-10 安全稽核 L-04：SSR 打 API 時要原樣轉發 Cookie header。Next 的 cookies() 會把同名 cookie
 * 合併成一個，API 就無法偵測子網域植入的重複 session cookie。
 */

const incoming = new Headers();
vi.mock("next/headers", () => ({
  headers: async () => incoming,
  cookies: async () => ({
    // 模擬 Next 的行為：同名 cookie 只剩最後一個
    getAll: () => [{ name: "__Host-dit_session", value: "real" }],
    has: () => true,
  }),
}));

describe("getServerApi", () => {
  let sent: Headers | undefined;
  beforeEach(() => {
    for (const key of [...incoming.keys()]) incoming.delete(key);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent = new Headers(init?.headers);
        return Response.json(
          {
            type: "https://dev-in.tw/problems/unauthenticated",
            title: "Authentication required",
            status: 401,
            code: "UNAUTHENTICATED",
            requestId: "test",
          },
          { status: 401, headers: { "content-type": "application/problem+json" } },
        );
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sent = undefined;
  });

  it("forwards the raw Cookie header so the API can see duplicated session cookies", async () => {
    incoming.set("cookie", "__Host-dit_session=planted; __Host-dit_session=real");
    incoming.set("x-forwarded-for", "203.0.113.7");
    const { getServerApi } = await import("../lib/api/server.ts");
    await getServerApi()("getMe").catch(() => {});
    expect(sent?.get("cookie")).toBe("__Host-dit_session=planted; __Host-dit_session=real");
    expect(sent?.get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("sends no Cookie header when the browser has none", async () => {
    const { getServerApi } = await import("../lib/api/server.ts");
    await getServerApi()("getMe").catch(() => {});
    expect(sent?.has("cookie")).toBe(false);
  });
});
