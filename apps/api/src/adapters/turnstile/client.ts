import { type FetchLike, fetchWithTimeout } from "../http.ts";

export interface TurnstileVerifier {
  verify(token: string, remoteIp: string | null): Promise<boolean>;
}

/** Cloudflare Turnstile siteverify。網路錯誤時 fail closed（回 false）。 */
export function createTurnstileVerifier(opts: {
  secretKey: string;
  expectedHostname: string;
  /** 測試金鑰回傳的 hostname 是固定值，不比對 */
  skipHostnameCheck: boolean;
  fetch?: FetchLike;
}): TurnstileVerifier {
  const doFetch = opts.fetch ?? fetch;
  return {
    async verify(token, remoteIp) {
      if (!token || token.length > 2048) return false;
      try {
        const form = new URLSearchParams({ secret: opts.secretKey, response: token });
        if (remoteIp) form.set("remoteip", remoteIp);
        const res = await fetchWithTimeout(
          doFetch,
          "https://challenges.cloudflare.com/turnstile/v0/siteverify",
          { method: "POST", body: form, timeoutMs: 5000 },
        );
        if (!res.ok) return false;
        const body = (await res.json()) as { success?: boolean; hostname?: string };
        if (body.success !== true) return false;
        return opts.skipHostnameCheck || body.hostname === opts.expectedHostname;
      } catch {
        return false;
      }
    },
  };
}
