import { loginAs, test } from "./fixtures.ts";

/**
 * 給主控者檢視用的截圖（不進 repo，見 apps/web/.gitignore）：
 *   pnpm --filter @dit/web e2e:screenshots
 */
const PAGES: { name: string; path: string; as?: "alice" | "admin" | "new"; type?: string }[] = [
  { name: "landing", path: "/" },
  { name: "landing-typed", path: "/", type: "taipei-bytes" },
  { name: "login", path: "/login" },
  { name: "claim", path: "/claim/my-lab", as: "new" },
  { name: "dashboard", path: "/dashboard", as: "alice" },
  { name: "subdomain-overview", path: "/dashboard/alice", as: "alice" },
  { name: "records", path: "/dashboard/alice/records", as: "alice" },
  { name: "subdomain-settings", path: "/dashboard/alice/settings", as: "alice" },
  { name: "transfers", path: "/dashboard/transfers", as: "alice" },
  { name: "settings", path: "/settings", as: "alice" },
  { name: "admin", path: "/admin", as: "admin" },
  { name: "admin-review", path: "/admin/review", as: "admin" },
  { name: "admin-zone", path: "/admin/zone", as: "admin" },
  { name: "explore", path: "/explore" },
  { name: "status", path: "/status" },
  { name: "report", path: "/report?name=free-gift" },
  { name: "docs", path: "/docs/github-pages" },
  { name: "terms", path: "/terms" },
  { name: "not-found", path: "/nope" },
];

for (const scheme of ["light", "dark"] as const) {
  test.describe(`@screenshots ${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1440, height: 900 } });
    for (const p of PAGES) {
      test(p.name, async ({ page, consoleErrors }) => {
        if (p.as === "alice") await loginAs(page, "alice");
        if (p.as === "admin") await loginAs(page, "HACO8888", { role: "admin" });
        if (p.as === "new") await loginAs(page, "new-dev");
        await page.goto(p.path);
        if (p.type) await page.getByLabel("想要的子網域名稱").fill(p.type);
        await page.waitForTimeout(1800);
        await page.screenshot({ path: `test/screenshots/${scheme}/${p.name}.png`, fullPage: true });
        // 404 頁本身的文件狀態碼會被瀏覽器記成 console error，這是預期的
        if (p.name === "not-found") {
          consoleErrors.splice(
            0,
            consoleErrors.length,
            ...consoleErrors.filter((e) => !e.includes("status of 404")),
          );
        }
      });
    }
  });
}

test.describe("@screenshots mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const p of [PAGES[0], PAGES[6]] as const) {
    test(`mobile ${p?.name}`, async ({ page }) => {
      if (p?.as === "alice") await loginAs(page, "alice");
      await page.goto(p?.path ?? "/");
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `test/screenshots/mobile/${p?.name}.png`, fullPage: true });
    });
  }
});
