import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  output: "standalone",
  // monorepo：standalone 追蹤檔案時以 repo 根目錄為準
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  transpilePackages: ["@dit/contract", "@dit/dns"],
  reactCompiler: true,
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  // 正式環境由 Traefik 把 /api 路由到 api 服務；本機開發才由 Next 轉發
  async rewrites() {
    return isDev ? [{ source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` }] : [];
  },
};

export default nextConfig;
