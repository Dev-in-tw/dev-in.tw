import { expect, expectAccessible, loginAs, test } from "./fixtures.ts";

const PUBLIC = [
  "/",
  "/login",
  "/claim/new-name",
  "/explore",
  "/status",
  "/report",
  "/docs",
  "/docs/github-pages",
  "/terms",
  "/privacy",
  "/aup",
  "/not-a-page",
];
const SIGNED_IN = [
  "/dashboard",
  "/dashboard/alice",
  "/dashboard/alice/records",
  "/dashboard/alice/settings",
  "/dashboard/alice/activity",
  "/dashboard/transfers",
  "/settings",
];
const ADMIN = [
  "/admin",
  "/admin/review",
  "/admin/reports",
  "/admin/subdomains",
  "/admin/users",
  "/admin/reserved",
  "/admin/audit",
  "/admin/zone",
  "/admin/settings",
];

for (const scheme of ["light", "dark"] as const) {
  test.describe(`axe (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test("public pages", async ({ page }) => {
      for (const path of PUBLIC) {
        await page.goto(path);
        await page.waitForLoadState("networkidle").catch(() => {});
        await test.step(path, () => expectAccessible(page));
      }
    });

    test("dashboard pages", async ({ page }) => {
      await loginAs(page, "alice");
      for (const path of SIGNED_IN) {
        await page.goto(path);
        await page.waitForTimeout(400);
        await test.step(path, () => expectAccessible(page));
      }
    });

    test("admin pages", async ({ page }) => {
      await loginAs(page, "HACO8888", { role: "admin" });
      for (const path of ADMIN) {
        await page.goto(path);
        await page.waitForTimeout(400);
        await test.step(path, () => expectAccessible(page));
      }
    });
  });
}

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("no running animations and the ticket shows without flipping", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("想要的子網域名稱").fill("calm-name");
    await expect(page.getByTestId("availability-live")).toHaveText(/可以申請/);
    const running = await page.evaluate(() =>
      document
        .getAnimations()
        .filter(
          (a) =>
            a.playState === "running" && (a.effect?.getComputedTiming().duration as number) > 50,
        )
        .map((a) => (a as CSSAnimation).animationName ?? "anonymous"),
    );
    expect(running).toEqual([]);
  });
});
