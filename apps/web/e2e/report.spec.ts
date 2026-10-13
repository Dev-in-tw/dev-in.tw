import { expect, test } from "./fixtures.ts";

test("public report form with ?name= prefill", async ({ page }) => {
  await page.goto("/report?name=free-gift");
  await expect(page.getByLabel("被檢舉的子網域")).toHaveValue("free-gift");
  await page.getByLabel("類型").selectOption("phishing");
  await page.getByLabel("說明").fill("這個網站假冒銀行登入頁面，要求輸入網銀帳號密碼。");
  await page.getByLabel(/我是人類/).check();
  await page.getByRole("button", { name: "送出檢舉" }).click();
  await expect(page.getByRole("status")).toContainText("收到了，謝謝你");
  await expect(page.getByRole("status")).toContainText("受理編號");
});
