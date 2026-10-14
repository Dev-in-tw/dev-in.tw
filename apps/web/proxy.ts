import { type NextRequest, NextResponse } from "next/server";
import { SITE } from "./lib/site.ts";
import { THEME_SCRIPT } from "./lib/theme-script.ts";

/**
 * 1. 登入保護：沒有 `__Host-dit_session` cookie 時，`/dashboard/*`、`/admin/*`、`/settings` 導向
 *    `/login?redirect=`。真正的權限判斷在 layout 裡呼叫 getMe()（非 admin 進 /admin 一律 404）。
 * 0. 轉址（依 Host）：`www.dev-in.tw` → 301 `https://dev-in.tw<path>`、`api.dev-in.tw` → 302
 *    `https://dev-in.tw/api/docs`。DNS 搬到 Lazco DNS 之後沒有 Cloudflare 代理幫忙轉址，這兩個 host
 *    直接由 Traefik（Let's Encrypt HTTP-01）送到 web。只比對 SITE 的固定網域，不反射任意的 Host。
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

/** 和 next.config.ts 的 HSTS 相同（不含 includeSubDomains：使用者的子網域不受影響） */
const HSTS = "max-age=63072000";

/** 去掉 port、轉小寫；IPv6 的 [::1]:3000 保留方括號內的位址 */
function hostnameOf(request: NextRequest): string {
  const raw = (request.headers.get("host") ?? request.nextUrl.host).trim().toLowerCase();
  return raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.replace(/:\d+$/, "");
}

/** www 與 api 子網域的轉址；其他 host 回 null */
export function hostRedirect(request: NextRequest): NextResponse | null {
  const host = hostnameOf(request);
  let target: string | null = null;
  let status = 301;
  if (host === `www.${SITE.rootDomain}`) {
    const { pathname, search } = request.nextUrl;
    target = `${SITE.origin}${pathname}${search}`;
  } else if (host === `api.${SITE.rootDomain}`) {
    // API 的正式位置是同源的 dev-in.tw/api（PLAN §7 Q15）；這個 host 只導到文件，P2 推出 PAT 時再啟用
    target = `${SITE.origin}/api/docs`;
    status = 302;
  }
  if (!target) return null;
  const response = NextResponse.redirect(target, status);
  response.headers.set("strict-transport-security", HSTS);
  response.headers.set("cache-control", status === 301 ? "public, max-age=86400" : "no-store");
  return response;
}

export async function proxy(request: NextRequest) {
  const redirect = hostRedirect(request);
  if (redirect) return redirect;
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
    // www／api 兩個 host 的每一個路徑都要轉址（包含下面那條排除的 /api、靜態檔與 prefetch）
    { source: "/:path*", has: [{ type: "host", value: "(?:www|api)\\.dev-in\\.tw" }] },
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
