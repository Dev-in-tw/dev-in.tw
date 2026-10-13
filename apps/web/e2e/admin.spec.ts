import { expect, loginAs, test } from "./fixtures.ts";

test.beforeEach(async ({ page }) => {
  await loginAs(page, "HACO8888", { role: "admin" });
});

test("review queue: approve a pending subdomain", async ({ page }) => {
  await page.goto("/admin/review");
  const item = page.getByRole("listitem").filter({ hasText: "paypa1-shop.dev-in.tw" });
  await expect(item).toContainText("和品牌「paypal」相似");
  await expect(item).toContainText("GitHub 帳號建立未滿 30 天");
  await item.getByRole("button", { name: "核准" }).click();
  await expect(page.getByText("已核准 paypa1-shop.dev-in.tw")).toBeVisible();
  await expect(page.getByText(";; 沒有資料")).toBeVisible();
});

test("review queue: reject requires a reason", async ({ page }) => {
  await page.goto("/admin/review");
  await page.getByRole("button", { name: "駁回" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "駁回申請" })).toBeDisabled();
  await dialog.getByLabel("理由").fill("名稱假冒知名品牌");
  await dialog.getByRole("button", { name: "駁回申請" }).click();
  await expect(page.getByText("已駁回 paypa1-shop.dev-in.tw")).toBeVisible();
});

test("report queue: suspend and close", async ({ page }) => {
  await page.goto("/admin/reports");
  await page.getByRole("button", { name: "停權並結案" }).click();
  await page.getByRole("dialog").getByLabel("理由").fill("確認為釣魚網站");
  await page.getByRole("dialog").getByRole("button", { name: "停權並結案" }).click();
  await expect(page.getByText("已停權 free-gift 並結案")).toBeVisible();
});

test("admin overview shows queues and zone usage", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("link", { name: /待審子網域/ })).toContainText("1");
  await expect(page.getByRole("meter", { name: "zone 紀錄用量" })).toBeVisible();
});
