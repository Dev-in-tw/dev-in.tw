import { readFileSync } from "node:fs";
import { LEGAL_DOCUMENTS } from "@dit/contract/legal";
import { describe, expect, it } from "vitest";
import { exportFilename } from "../components/dashboard/user-settings.tsx";
import { LEGAL_DOCS } from "../lib/legal.ts";

const mdx = (slug: string) =>
  readFileSync(new URL(`../content/legal/${slug}.mdx`, import.meta.url), "utf8");

describe("legal documents", () => {
  it("take their versions from the shared contract constants", () => {
    for (const [slug, doc] of Object.entries(LEGAL_DOCS)) {
      expect(doc.version).toBe(LEGAL_DOCUMENTS[slug as keyof typeof LEGAL_DOCUMENTS].version);
      expect(doc.effective).toBe(LEGAL_DOCUMENTS[slug as keyof typeof LEGAL_DOCUMENTS].effective);
    }
  });

  it("have a revision log entry for the current version", () => {
    for (const doc of Object.values(LEGAL_DOCS)) {
      expect(mdx(doc.slug), doc.slug).toContain(`- v${doc.version}（`);
    }
  });

  it("the privacy policy states the retention periods the code enforces", () => {
    const text = mdx("privacy");
    expect(text).toMatch(/檢舉[^\n]*處理完成[^\n]*滿 1 年/); // REPORT_RETENTION_DAYS = 365
    expect(text).toContain("最長 30 天"); // 容器日誌輪替
    expect(text).toContain("14 份"); // 每日資料庫備份
    expect(text).toContain("Cloudflare R2");
    expect(text).toContain("下載"); // 資料匯出
    expect(text).toContain("同意紀錄");
  });
});

describe("data export filename", () => {
  it("uses the login and the date", () => {
    expect(exportFilename("Alice", new Date("2026-10-14T08:00:00Z"))).toBe(
      "dev-in-tw-alice-2026-10-14.json",
    );
  });
});
