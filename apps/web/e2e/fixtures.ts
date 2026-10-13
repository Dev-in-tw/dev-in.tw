import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";

/** mock gateway 的 origin（見 playwright.config.ts）；寫入請求的 Origin 必須完全相等 */
export const ORIGIN = "http://localhost:3101";

/**
 * 共用 fixture：
 * - 每個 test 前重設 mock 狀態（測試之間不互相污染）
 * - 收集 console error、pageerror 與 hydration warning，test 結束時斷言為零。
 *   唯一的例外是 API 刻意回的 4xx／501（例如驗證失敗、P1 未實作）：瀏覽器一定會把它們印成
 *   「Failed to load resource」，那是預期中的 problem+json 回應，不是程式錯誤。
 */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page, request }, use) => {
      await request.post("/api/__mock/reset");
      const errors: string[] = [];
      page.on("console", (msg) => {
        const text = msg.text();
        const expectedApiProblem =
          /Failed to load resource: the server responded with a status of (4\d\d|501)/.test(text) &&
          msg.location().url.includes("/api/");
        // 刻意造訪不存在的頁面時，404 文件本身也會被記成 console error
        const expectedNotFound =
          /status of 404/.test(text) && /\/(not-a-page|nope)$/.test(msg.location().url);
        if (expectedApiProblem || expectedNotFound) return;
        if (msg.type() === "error" || /hydrat/i.test(text))
          errors.push(`[console] ${text} @ ${msg.location().url}`);
      });
      page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
      await use(errors);
      expect(errors, "console 不應出現 error 或 hydration warning").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function loginAs(
  page: Page,
  githubLogin = "alice",
  opts: { role?: "user" | "admin"; githubAgeDays?: number } = {},
) {
  const res = await page.request.post("/api/v1/auth/dev-login", {
    data: { githubLogin, role: opts.role ?? "user", githubAgeDays: opts.githubAgeDays ?? 365 },
    headers: { origin: ORIGIN },
  });
  expect(res.status()).toBe(204);
}

export async function mockConfig(page: Page, config: Record<string, unknown>) {
  const res = await page.request.post("/api/__mock/config", { data: config });
  expect(res.ok()).toBeTruthy();
}

/** axe：0 個 serious 或 critical（PLAN §4.5） */
export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    bad.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.nodes
          .map((n) => n.target.join(" "))
          .slice(0, 3)
          .join(" | ")}`,
    ),
  ).toEqual([]);
}
