import { and, isNotNull, isNull, lt, ne } from "drizzle-orm";
import type { Deps } from "../../context.ts";
import { reports } from "../../db/schema.ts";
import { DAY } from "../../lib/clock.ts";

/** 隱私權政策第 8 條：檢舉處理完成（成立或駁回）滿這麼久之後，清除檢舉中的個人資料 */
export const REPORT_RETENTION_DAYS = 365;

/**
 * 清除結案滿 REPORT_RETENTION_DAYS 天的檢舉：聯絡 email、IP 雜湊、說明內容與檢舉人帳號的關聯。
 * 保留子網域名稱、類別、處理結果與時間，作為統計與防止重複濫用的依據。尚未結案的檢舉不動。
 */
export async function redactClosedReports(deps: Pick<Deps, "db" | "clock">): Promise<number> {
  const now = deps.clock.now();
  const cutoff = new Date(now.getTime() - REPORT_RETENTION_DAYS * DAY);
  const rows = await deps.db
    .update(reports)
    .set({
      contactEmail: null,
      reporterIpHash: null,
      reporterUserId: null,
      details: "",
      redactedAt: now,
    })
    .where(
      and(
        isNull(reports.redactedAt),
        ne(reports.status, "open"),
        isNotNull(reports.resolvedAt),
        lt(reports.resolvedAt, cutoff),
      ),
    )
    .returning({ id: reports.id });
  return rows.length;
}
