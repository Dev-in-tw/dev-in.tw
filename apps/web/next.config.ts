import { fileURLToPath } from "node:url";
import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3001";

/**
 * 不含 CSP 的安全標頭。CSP 由 proxy.ts 依路徑決定（登入後頁面用 nonce、行銷頁用靜態版本），
 * 這裡不能再送一條，否則瀏覽器會同時套用兩條 policy。
 *
 * Permissions-Policy 只關掉網站確定用不到、Turnstile 也不需要的功能（Turnstile 會用到 Private
 * State Token，所以不列 private-state-token-*）。
 */
const securityHeaders = [
  // 不加 includeSubDomains 與 preload：會強迫所有使用者站台都走 HTTPS（PLAN §6 Q14）
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // 和其他網站（包含同 site 的使用者子網域）開的視窗隔離 browsing context group
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // 頁面與資源不讓其他網站以 no-cors 方式嵌入（OG 圖片例外，見下方）
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "autoplay=()",
      "browsing-topics=()",
      "camera=()",
      "display-capture=()",
      "geolocation=()",
      "gyroscope=()",
      "hid=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "serial=()",
      "usb=()",
    ].join(", "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // monorepo：standalone 追蹤檔案時以 repo 根目錄為準
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  transpilePackages: ["@dit/contract", "@dit/dns"],
  pageExtensions: ["ts", "tsx", "mdx"],
  reactCompiler: true,
  // cacheComponents（與依賴它的 partialPrefetching）刻意關閉：Partial Prerendering 的靜態 shell
  // 拿不到每個請求的 nonce，和 PLAN §3.7 決定的 nonce CSP 不相容。行銷頁仍是一般的靜態生成。
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // 社群預覽圖可能被其他網站直接以 <img> 引用
      {
        source: "/opengraph-image",
        headers: [{ key: "Cross-Origin-Resource-Policy", value: "cross-origin" }],
      },
    ];
  },
  // 正式環境由 Traefik 把 /api 路由到 api 服務；本機開發才由 Next 轉發
  async rewrites() {
    return isDev ? [{ source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` }] : [];
  },
};

const withMDX = createMDX({});

export default withMDX(nextConfig);
