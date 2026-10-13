import { type NextRequest, NextResponse } from "next/server";
import { THEME_SCRIPT } from "./lib/theme-script.ts";

/**
 * 1. 登入保護：沒有 `__Host-dit_session` cookie 時，`/dashboard/*`、`/admin/*`、`/settings` 導向
 *    `/login?redirect=`。真正的權限判斷在 layout 裡呼叫 getMe()（非 admin 進 /admin 一律 404）。
 * 2. CSP（PLAN §3.7）：登入後與申請相關頁面用每個請求一個 nonce 的嚴格版本；行銷頁維持靜態，
 *    用不含 nonce 的版本。每個回應只送一條 CSP，避免瀏覽器同時套用兩條。
 *
 * 和 PLAN 的差異：兩種 policy 都加上 `style-src 'self' 'unsafe-inline'`。React 會輸出 style 屬性
 * （游標光暈的 --x/--y、odometer 的 --target、view-transition-name），沒有這條就會退回
 * `default-src 'self'` 而被擋下。
 */

const PROTECTED = ["/dashboard", "/admin", "/settings"];
const NONCE_PAGES = [...PROTECTED, "/login", "/claim"];
const TURNSTILE = "https://challenges.cloudflare.com";

const matches = (path: string, prefixes: string[]) =>
  prefixes.some((p) => path === p || path.startsWith(`${p}/`));

let themeHash: Promise<string> | undefined;
function themeScriptHash(): Promise<string> {
  themeHash ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(THEME_SCRIPT))
    .then((buf) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(buf)))}'`);
  return themeHash;
}

function common(isDev: boolean): string[] {
  return [
    "default-src 'self'",
    `frame-src ${TURNSTILE}`,
    "img-src 'self' https://avatars.githubusercontent.com data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws:" : ""}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self' https://github.com",
    "manifest-src 'self'",
  ];
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isDev = process.env.NODE_ENV === "development";

  if (matches(pathname, PROTECTED) && !request.cookies.has("__Host-dit_session")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?redirect=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  if (matches(pathname, NONCE_PAGES)) {
    const nonce = btoa(crypto.randomUUID());
    const csp = [
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${await themeScriptHash()} ${TURNSTILE}${isDev ? " 'unsafe-eval'" : ""}`,
      ...common(isDev),
    ].join("; ");
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("content-security-policy", csp);
    const response = NextResponse.next({ request: { headers } });
    response.headers.set("content-security-policy", csp);
    response.headers.set("cache-control", "private, no-store");
    return response;
  }

  const response = NextResponse.next();
  response.headers.set(
    "content-security-policy",
    [
      `script-src 'self' 'unsafe-inline' ${TURNSTILE}${isDev ? " 'unsafe-eval'" : ""}`,
      ...common(isDev),
    ].join("; "),
  );
  return response;
}

export const config = {
  matcher: [
    {
      source:
        "/((?!api/|_next/static|_next/image|favicon.ico|icon|apple-icon|opengraph-image|taiwan-dots.bin|robots.txt|sitemap.xml|\\.well-known/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
