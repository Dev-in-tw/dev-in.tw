import "server-only";
import { type Client, ApiError as ContractApiError, createClient, type Me } from "@dit/contract";
import { cookies, headers as requestHeaders } from "next/headers";
import { cache } from "react";

/** RSC 在 server 端打 API：`${API_INTERNAL_URL}/api/v1`，並轉發瀏覽器的 cookie */
function internalBase(): string {
  const origin = process.env.API_INTERNAL_URL ?? "http://localhost:3001";
  return `${origin.replace(/\/+$/, "")}/api/v1`;
}

export const getServerApi = cache((): Client => {
  return createClient({
    baseUrl: internalBase(),
    validateResponses: process.env.NODE_ENV !== "production",
    async headers(): Promise<Record<string, string>> {
      const [jar, incoming] = await Promise.all([cookies(), requestHeaders()]);
      const out: Record<string, string> = {};
      const cookie = jar
        .getAll()
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      if (cookie) out.cookie = cookie;
      // 原樣轉發 X-Forwarded-For：API 以 TRUSTED_PROXY_HOPS 從右數取 client IP 做限流，
      // 少了它所有訪客會共用 web 容器的 IP 額度
      for (const name of ["x-forwarded-for", "x-request-id", "user-agent", "accept-language"]) {
        const value = incoming.get(name);
        if (value) out[name] = value;
      }
      return out;
    },
  });
});

/** 同一個請求內只打一次 /me；未登入回 null */
export const getMe = cache(async (): Promise<Me | null> => {
  try {
    return await getServerApi()("getMe");
  } catch (error) {
    if (error instanceof ContractApiError && error.code === "UNAUTHENTICATED") return null;
    throw error;
  }
});

/** 給不需要登入的頁面用：API 掛掉或未登入都回 null，不讓頁面整個壞掉 */
export const getMeSafe = cache(async (): Promise<Me | null> => {
  try {
    return await getMe();
  } catch {
    return null;
  }
});

/** 只看有沒有 session cookie（不打 API），給 proxy 以外需要快速判斷的地方用 */
export async function hasSessionCookie(): Promise<boolean> {
  const jar = await cookies();
  return jar.has("__Host-dit_session");
}

export { ContractApiError };
