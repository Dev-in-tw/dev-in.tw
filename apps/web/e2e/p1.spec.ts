import { expect, loginAs, mockConfig, test } from "./fixtures.ts";

test.describe("@p1", () => {
  test("SSE: a new record flips from PENDING to SYNCED and is announced", async ({ page }) => {
    await loginAs(page, "alice");
    await page.goto("/dashboard/alice/records");
    await expect(page.getByText("即時同步")).toBeVisible();
    const form = page.getByRole("form", { name: "新增紀錄" }).first();
    await form.getByLabel("類型").selectOption("TXT");
    await form.getByLabel("名稱").fill("_hello");
    await form.getByLabel(/^值/).fill("world");
    await form.getByRole("button", { name: "新增紀錄" }).click();
    const row = page.getByTestId("record-_hello-TXT");
    await expect(row).toHaveAttribute("data-status", "pending");
    await expect(row).toHaveAttribute("data-status", "synced", { timeout: 5000 });
    await expect(page.getByTestId("sync-live")).toHaveText("_hello TXT 已同步");
  });

  test("propagation check lists the four resolvers including TWNIC Quad101", async ({ page }) => {
    await loginAs(page, "alice");
    await page.goto("/dashboard/alice");
    const resolvers = page.getByTestId("resolvers");
    await expect(resolvers.getByRole("listitem")).toHaveCount(4);
    await expect(resolvers).toContainText("TWNIC Quad101");
    await expect(resolvers).toContainText("已生效");
  });

  test("transfer: alice sends, bob-dev accepts", async ({ page, browser }) => {
    await loginAs(page, "alice");
    await page.goto("/dashboard/alice/settings");
    await page.getByLabel("對方的 GitHub 帳號").fill("bob-dev");
    await page.getByRole("button", { name: "送出轉移邀請" }).click();
    await expect(page.getByText(/已邀請 @bob-dev 接收/)).toBeVisible();

    const bob = await browser.newPage();
    await loginAs(bob, "bob-dev");
    await bob.goto("/dashboard/transfers");
    const item = bob.getByRole("listitem").filter({ hasText: "alice.dev-in.tw" });
    await item.getByRole("button", { name: "接受" }).click();
    await expect(bob.getByText("轉移已接受")).toBeVisible();
    await bob.goto("/dashboard");
    await expect(bob.getByRole("link", { name: /alice\.dev-in\.tw/ }).first()).toBeVisible();
    await bob.close();
  });

  test("full status page shows every component and the sync queue", async ({ page }) => {
    await page.goto("/status");
    const list = page.getByTestId("status-components");
    await expect(list.getByRole("listitem")).toHaveCount(4);
    await expect(list).toContainText("同步 worker");
    await expect(page.getByText("同步佇列", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: /最近 \d+ 次檢查/ }).first()).toBeVisible();
  });

  test("session management: sign out other devices", async ({ page, browser }) => {
    const other = await browser.newPage();
    await loginAs(other, "alice");
    await loginAs(page, "alice");
    await page.goto("/settings");
    const sessions = page.getByTestId("sessions");
    await expect(sessions.getByRole("listitem")).toHaveCount(2);
    await expect(sessions).toContainText("[ 目前這台 ]");
    await page.getByRole("button", { name: "登出其他所有裝置" }).click();
    await expect(sessions.getByRole("listitem")).toHaveCount(1);
    await other.goto("/dashboard");
    await expect(other).toHaveURL(/\/login/);
    await other.close();
  });
});

test("P1 endpoints answering 501 degrade gracefully", async ({ page }) => {
  await mockConfig(page, {
    notImplemented: [
      "events",
      "getPropagation",
      "listTransfers",
      "listSessions",
      "listMyActivity",
      "listDirectory",
      "getStatus",
    ],
  });
  await loginAs(page, "alice");

  await page.goto("/dashboard");
  await expect(page.getByText("活動紀錄即將推出。")).toBeVisible();
  await expect(page.getByText("輪詢模式")).toBeVisible();

  await page.goto("/dashboard/alice");
  await expect(page.getByTestId("propagation-coming-soon")).toBeVisible();

  await page.goto("/dashboard/transfers");
  await expect(page.getByTestId("transfers-coming-soon")).toBeVisible();

  await page.goto("/settings");
  await expect(page.getByTestId("sessions-coming-soon")).toBeVisible();

  await page.goto("/explore");
  await expect(page.getByTestId("explore-coming-soon")).toBeVisible();

  await page.goto("/status");
  await expect(page.getByTestId("status-error")).toHaveText("完整狀態頁即將推出。");

  // SSE 不可用時，pending 紀錄改用輪詢更新
  await page.goto("/dashboard/alice/records");
  const form = page.getByRole("form", { name: "新增紀錄" }).first();
  await form.getByLabel("類型").selectOption("TXT");
  await form.getByLabel("名稱").fill("_poll");
  await form.getByLabel(/^值/).fill("ok");
  await form.getByRole("button", { name: "新增紀錄" }).click();
  await expect(page.getByTestId("record-_poll-TXT")).toHaveAttribute("data-status", "synced", {
    timeout: 10_000,
  });
});
