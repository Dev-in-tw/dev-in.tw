import { defineConfig } from "tsdown";

// 把 workspace 套件與所有依賴打包成單一檔案，runtime 映像不需要 node_modules（§3.13）
export default defineConfig({
  entry: { server: "src/main.ts", migrate: "src/db/migrate.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  sourcemap: true,
  dts: false,
  clean: true,
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  outExtensions: () => ({ js: ".mjs" }),
});
