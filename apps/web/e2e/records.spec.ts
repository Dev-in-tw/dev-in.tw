import { expect, loginAs, test } from "./fixtures.ts";

test.beforeEach(async ({ page }) => {
  await loginAs(page, "alice");
  await page.goto("/dashboard/alice/records");
  await expect(page.getByRole("table", { name: /alice\.dev-in\.tw 的 DNS 紀錄/ })).toBeVisible();
});

const addForm = (page: import("@playwright/test").Page) =>
  page.getByRole("form", { name: "新增紀錄" }).first();

test("rejects private addresses before they reach the server", async ({ page }) => {
  const form = addForm(page);
  await form.getByLabel("類型").selectOption("A");
  await form.getByLabel("名稱").fill("lab");
  await form.getByLabel(/位址/).fill("10.0.0.1");
  await form.getByRole("button", { name: "新增紀錄" }).click();
  await expect(form.getByText(/10\.0\.0\.1.*(私有|保留|公網)/)).toBeVisible();
  await expect(page.getByTestId("record-lab-A")).toHaveCount(0);
});

test("add, edit with a type change, then delete with undo", async ({ page }) => {
  const form = addForm(page);
  await form.getByLabel("類型").selectOption("A");
  await form.getByLabel("名稱").fill("lab");
  await form.getByLabel(/位址/).fill("1.2.3.4");
  await form.getByRole("button", { name: "新增紀錄" }).click();

  const row = page.getByTestId("record-lab-A");
  await expect(row).toBeVisible();
  await expect(page.getByTestId("record-usage")).toHaveText("6 / 10");

  // 改 type：A → CNAME（後端以 batch 先刪後建，前端只送 PUT + If-Match）
  await row.getByRole("button", { name: "編輯 lab A" }).click();
  const edit = page.locator("[data-testid^='edit-']");
  await edit.getByLabel("類型").selectOption("CNAME");
  await edit.getByLabel(/目標/).fill("lab.example.net");
  await edit.getByRole("button", { name: "儲存" }).click();
  const cname = page.getByTestId("record-lab-CNAME");
  await expect(cname).toBeVisible();
  await expect(cname).toContainText("lab.example.net");

  // 刪除先畫刪除線，5 秒內可以復原
  await cname.getByRole("button", { name: "刪除 lab CNAME" }).click();
  await expect(cname).toHaveAttribute("data-status", /pending|synced/);
  await page.getByRole("button", { name: "復原" }).click();
  await page.waitForTimeout(5500);
  await expect(page.getByTestId("record-lab-CNAME")).toBeVisible();

  // 再刪一次，等 Undo 視窗結束後真的送出 DELETE
  await cname.getByRole("button", { name: "刪除 lab CNAME" }).click();
  await expect(page.getByTestId("record-lab-CNAME")).toHaveCount(0, { timeout: 12_000 });
});

test("keyboard: Enter opens inline edit, Esc cancels", async ({ page }) => {
  await page.getByTestId("record-www-CNAME").getByTestId("record-name").focus();
  await page.keyboard.press("Enter");
  const edit = page.locator("[data-testid^='edit-']");
  await expect(edit).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(edit).toHaveCount(0);
});

test("copy as zone file and the zone tree are available", async ({ page }) => {
  await expect(page.getByRole("button", { name: "複製整份 zone file" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "zone tree" })).toContainText(
    "_github-pages-challenge-alice",
  );
});

test("preset: GitHub Pages diff preview, then apply", async ({ page }) => {
  await page.goto("/dashboard/alice");
  await page.getByRole("button", { name: /GitHub Pages/ }).click();
  await expect(page.getByLabel(/GitHub 使用者或組織/)).toHaveValue("alice");
  await page.getByRole("button", { name: "預覽變更" }).click();
  const diff = page.getByRole("region", { name: "變更預覽" });
  await expect(diff.locator("[data-diff=create]")).toContainText("alice.github.io");
  await expect(diff.locator("[data-diff=delete]")).toHaveCount(3);
  await page.getByRole("button", { name: /套用（\+1 −3）/ }).click();
  await expect(page.getByText("已套用 GitHub Pages")).toBeVisible();
  await page.goto("/dashboard/alice/records");
  await expect(page.getByTestId("record-@-CNAME")).toContainText("alice.github.io");
  await expect(page.getByTestId("record-@-A")).toHaveCount(0);
});

test("command palette add opens a prefilled editor row", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "指令面板" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").fill("add txt _atproto did=did:plc:abc123");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/add=TXT&name=_atproto/);
  const form = addForm(page);
  await expect(form.getByLabel("名稱")).toHaveValue("_atproto");
  await expect(form.getByLabel(/^值/)).toHaveValue("did=did:plc:abc123");
});
