import { expect, loginAs, test } from "./fixtures.ts";

test("protected routes redirect to login with the original path", async ({ page }) => {
  await page.goto("/dashboard/alice/records");
  await expect(page).toHaveURL(/\/login\?redirect=%2Fdashboard%2Falice%2Frecords/);
  await expect(page.getByRole("heading", { name: "登入 Dev-in.tw" })).toBeVisible();
});

test("signed-in pages are served with a nonce CSP and marketing pages with the static policy", async ({
  page,
}) => {
  await loginAs(page);
  const dash = await page.goto("/dashboard");
  expect(dash?.headers()["content-security-policy"]).toMatch(
    /'nonce-[^']+' 'strict-dynamic' 'sha256-/,
  );
  const home = await page.goto("/");
  const csp = home?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("'unsafe-inline'");
  expect(csp).not.toContain("nonce-");
  expect(csp).toContain("frame-ancestors 'none'");
});

test("landing availability check shows the terminal verdict", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("想要的子網域名稱");
  await input.fill("taipei-bytes");
  await expect(page.getByTestId("availability-live")).toHaveText(/已被使用/);
  await input.fill("brand-new-name");
  await expect(page.getByTestId("availability-live")).toHaveText(/可以申請/);
  await input.press("Enter");
  await expect(page).toHaveURL(/\/claim\/brand-new-name$/);
});

test("non-admins get a 404 for the admin console", async ({ page, consoleErrors }) => {
  await loginAs(page, "alice");
  const res = await page.goto("/admin");
  expect(res?.status()).toBe(404);
  await expect(page.getByText("NXDOMAIN", { exact: true })).toBeVisible();
  // 瀏覽器會把 404 文件本身記成 console error，這正是這個測試要的結果
  consoleErrors.splice(
    0,
    consoleErrors.length,
    ...consoleErrors.filter((e) => !e.includes("status of 404")),
  );
});

test("security.txt, robots and sitemap are served", async ({ request }) => {
  const sec = await request.get("/.well-known/security.txt");
  expect(await sec.text()).toContain("Contact: mailto:security@dev-in.tw");
  expect((await request.get("/robots.txt")).ok()).toBeTruthy();
  expect(await (await request.get("/sitemap.xml")).text()).toContain(
    "https://dev-in.tw/docs/github-pages",
  );
});
