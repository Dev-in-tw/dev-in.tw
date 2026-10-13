import { expect, test } from "./fixtures.ts";

test("claim flow: anonymous → GitHub login → apply → activation ticket", async ({ page }) => {
  await page.goto("/claim/e2e-lab");
  await expect(page.getByTestId("availability-live")).toHaveText(/可以申請/);
  await page.getByLabel("用途描述（選填）").fill("e2e 測試用的實驗站");
  await page.getByRole("button", { name: "登入後申請" }).click();

  // 登入頁說明會讀取哪些資料 → mock 的 GitHub 授權頁 → 回到原本的申請頁，草稿還在
  await expect(page).toHaveURL(/\/login\?redirect=%2Fclaim%2Fe2e-lab/);
  await page.getByRole("link", { name: "使用 GitHub 登入" }).click();
  await expect(page).toHaveURL(/\/api\/__mock\/github/);
  await page.getByRole("button", { name: /new-dev/ }).click();
  await expect(page).toHaveURL(/\/claim\/e2e-lab$/);
  await expect(page.getByLabel("用途描述（選填）")).toHaveValue("e2e 測試用的實驗站");

  await page.getByLabel(/我已閱讀並同意/).check();
  await page.getByLabel(/我是人類/).check();
  await page.getByRole("button", { name: "開通" }).click();

  const ticket = page.getByRole("region", { name: /開通成功/ });
  await expect(ticket).toBeVisible();
  await expect(ticket.getByText("e2e-lab", { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId("ticket-serial")).toHaveText(/No\. \d{6}/);
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  await page.getByRole("link", { name: "設定 DNS" }).click();
  await expect(page).toHaveURL(/\/dashboard\/e2e-lab$/);
});

test("names that look like brands go to review", async ({ page }) => {
  await page.goto("/claim/paypal-login");
  await expect(page.getByTestId("availability-live")).toHaveText(/人工審核/);
  await expect(
    page.getByRole("group", { name: /步驟 1/ }).getByText("送出後需要人工審核"),
  ).toBeVisible();
});

test("taken names offer clickable suggestions and a report link", async ({ page }) => {
  await page.goto("/claim/taipei-bytes");
  await expect(page.getByTestId("availability-live")).toHaveText(/已被使用/);
  await expect(page.getByRole("link", { name: /檢舉 taipei-bytes/ })).toHaveAttribute(
    "href",
    "/report?name=taipei-bytes",
  );
  await page.getByRole("link", { name: "taipei-bytes-dev" }).click();
  await expect(page).toHaveURL(/\/claim\/taipei-bytes-dev$/);
});
