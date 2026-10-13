import { defineConfig, devices } from "@playwright/test";

/**
 * e2e 對 mock API 執行（PLAN §5.4）。拓撲比照正式環境：
 *   瀏覽器 → mock gateway :3101（/api 由 mock 處理，其餘轉給 Next）→ next start :3100
 * 必須先 `next build`；用 production build 才能驗證 nonce CSP、沒有 hydration warning 與 console error。
 */
const WEB_PORT = 3100;
const GATEWAY_PORT = 3101;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: `http://localhost:${GATEWAY_PORT}`,
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node scripts/start-standalone.mjs",
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(WEB_PORT), API_INTERNAL_URL: `http://localhost:${GATEWAY_PORT}` },
      timeout: 60_000,
    },
    {
      command: "node mock/server.ts",
      port: GATEWAY_PORT,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(GATEWAY_PORT), MOCK_GATEWAY: `http://localhost:${WEB_PORT}` },
      timeout: 30_000,
    },
  ],
});
