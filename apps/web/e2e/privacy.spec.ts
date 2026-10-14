import { readFile } from "node:fs/promises";
import { CURRENT_LEGAL_VERSIONS } from "@dit/contract/legal";
import { expect, loginAs, test } from "./fixtures.ts";

/** 隱私權政策 v1.1 的控制：同意紀錄、資料下載、刪除帳號說明、管理端的清除與保存期限 */

test("login page states the versions the user agrees to and sends them along", async ({ page }) => {
  await page.goto("/login?redirect=/dashboard");
  const notice = page.getByTestId("login-consent");
  await expect(notice).toContainText(`v${CURRENT_LEGAL_VERSIONS.termsVersion}`);
  await expect(notice).toContainText(`v${CURRENT_LEGAL_VERSIONS.privacyVersion}`);
  const href = await page.getByRole("link", { name: "使用 GitHub 登入" }).getAttribute("href");
  const url = new URL(href as string, "http://localhost");
  expect(url.searchParams.get("termsVersion")).toBe(CURRENT_LEGAL_VERSIONS.termsVersion);
  expect(url.searchParams.get("privacyVersion")).toBe(CURRENT_LEGAL_VERSIONS.privacyVersion);
  expect(url.searchParams.get("redirect")).toBe("/dashboard");
});

test("users must agree again after the documents change", async ({ page }) => {
  await loginAs(page, "alice");
  const res = await page.request.post("/api/__mock/consent", {
    data: { login: "alice", stale: true },
  });
  expect(res.ok()).toBeTruthy();

  await page.goto("/dashboard");
  const gate = page.getByRole("dialog", { name: "服務條款與隱私權政策已更新" });
  await expect(gate).toBeVisible();
  await expect(gate).toContainText(`隱私權政策 v0.9`);
  // 不能用 Esc 關掉
  await page.keyboard.press("Escape");
  await expect(gate).toBeVisible();

  await gate.getByRole("button", { name: "我已閱讀並同意" }).click();
  await expect(gate).toBeHidden();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const me = await (await page.request.get("/api/v1/me")).json();
  expect(me).toMatchObject({ consentRequired: false, consent: CURRENT_LEGAL_VERSIONS });
});

test("users who decline can sign out from the consent dialog", async ({ page }) => {
  await loginAs(page, "alice");
  await page.request.post("/api/__mock/consent", { data: { login: "alice", stale: true } });
  await page.goto("/settings");
  await page.getByRole("dialog").getByRole("button", { name: "登出" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("settings: download my data as JSON", async ({ page }) => {
  await loginAs(page, "alice");
  await page.goto("/settings");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-data").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^dev-in-tw-alice-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(data.format).toBe("dev-in.tw/user-data-export@1");
  expect(data.account.githubLogin).toBe("alice");
  expect(data.subdomains.map((s: { name: string }) => s.name)).toContain("alice");
  expect(JSON.stringify(data)).not.toContain("bob-dev@example.com");
  await expect(page.getByText("已下載你的資料")).toBeVisible();
});

test("settings: the account deletion notice matches the privacy policy", async ({ page }) => {
  await loginAs(page, "alice");
  await page.goto("/settings");
  const notice = page.getByTestId("delete-account-notice");
  await expect(notice).toContainText("30 天冷卻期");
  await expect(notice).toContainText("稽核紀錄保存 1 年");
  await expect(notice).toContainText("90 天後清除");
  await expect(notice).toContainText("結案 1 年後清除");
  await expect(notice).toContainText("14 天");
  await expect(notice).not.toContainText("法律要求");
  await expect(notice.getByRole("link", { name: "隱私權政策第 9 條" })).toHaveAttribute(
    "href",
    "/privacy",
  );
});

test.describe("admin", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "HACO8888", { role: "admin" });
  });

  test("zone: requeue a dead sync job", async ({ page }) => {
    await page.goto("/admin/zone");
    await expect(page.getByRole("heading", { name: "Dead jobs（1）" })).toBeVisible();
    await page.getByRole("button", { name: "重新排入 #42" }).click();
    await expect(page.getByText("已重新排入 #42")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Dead jobs（0）" })).toBeVisible();
  });

  test("reports: redacted reports say their details were erased", async ({ page }) => {
    await page.goto("/admin/reports");
    await page.getByLabel("狀態").selectOption("dismissed");
    const redacted = page.getByTestId("report-redacted");
    await expect(redacted).toContainText("已於");
    await expect(page.getByText("聯絡：已清除")).toBeVisible();
  });
});
