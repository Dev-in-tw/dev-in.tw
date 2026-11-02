"use client";

import type { ComponentStatus, SyncBatching } from "@dit/contract";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { useEffect, useState } from "react";
import { isNotImplemented } from "@/lib/api/client.ts";
import { cn } from "@/lib/cn.ts";
import { errorMessage } from "@/lib/errors.ts";
import { q } from "@/lib/queries.ts";
import { formatDateTime } from "@/lib/time.ts";

const NAMES = {
  api: "API",
  database: "資料庫",
  dns_provider: "DNS 供應商",
  sync_worker: "同步 worker",
} as const;
const LABEL: Record<ComponentStatus, string> = {
  operational: "正常",
  degraded: "效能下降",
  down: "中斷",
};
const HISTORY_KEY = "dit-status-history";

function Icon({ status }: { status: ComponentStatus }) {
  if (status === "operational") return <CircleCheck className="size-5 text-signal" aria-hidden />;
  if (status === "degraded") return <CircleAlert className="size-5 text-amber" aria-hidden />;
  return <CircleX className="size-5 text-danger" aria-hidden />;
}

/**
 * 狀態頁：每 30 秒更新。uptime 條記錄這個瀏覽器最近 90 次檢查（存在 localStorage，只是觀察紀錄，
 * 不是正式 SLA 數據）；後端日後提供歷史端點時改用它。
 */
export function StatusBoard() {
  const { data, error, dataUpdatedAt } = useQuery(q.status());
  const [history, setHistory] = useState<Record<string, ComponentStatus[]>>({});

  useEffect(() => {
    try {
      setHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}"));
    } catch {}
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次重新抓取（dataUpdatedAt 改變）都要記一筆，即使內容相同
  useEffect(() => {
    if (!data) return;
    setHistory((prev) => {
      const next = { ...prev };
      for (const c of data.components) next[c.id] = [...(prev[c.id] ?? []), c.status].slice(-90);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [data, dataUpdatedAt]);

  if (error) {
    return (
      <p className="mt-8 text-ink-muted" data-testid="status-error">
        {isNotImplemented(error) ? "完整狀態頁即將推出。" : `無法取得狀態：${errorMessage(error)}`}
      </p>
    );
  }
  if (!data)
    return (
      <div className="mt-8 h-60 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" />
    );

  return (
    <div className="mt-8 space-y-8">
      <div
        className={cn(
          "flex items-center gap-3 rounded-md border p-5",
          data.overall === "operational"
            ? "border-signal bg-signal-soft"
            : data.overall === "degraded"
              ? "border-amber bg-amber-soft"
              : "border-danger bg-danger-soft",
        )}
        role="status"
      >
        <Icon status={data.overall} />
        <p className="text-step-1 font-semibold">
          {data.overall === "operational"
            ? "所有系統正常運作"
            : data.overall === "degraded"
              ? "部分系統效能下降"
              : "服務中斷中"}
        </p>
        <p className="zone ml-auto text-xs text-ink-muted">
          檢查於 {formatDateTime(data.checkedAt)}
        </p>
      </div>
      <ul
        className="divide-y divide-rule rounded-md border border-rule bg-bg"
        data-testid="status-components"
      >
        {data.components.map((c) => (
          <li key={c.id} className="p-5">
            <div className="flex flex-wrap items-center gap-3">
              <Icon status={c.status} />
              <span className="font-medium">{NAMES[c.id]}</span>
              <span
                className={cn(
                  "zone text-sm",
                  c.status === "operational"
                    ? "text-signal"
                    : c.status === "degraded"
                      ? "text-amber"
                      : "text-danger",
                )}
              >
                [ {LABEL[c.status]} ]
              </span>
              {c.detail ? <span className="text-sm text-ink-muted">{c.detail}</span> : null}
            </div>
            <UptimeBar statuses={history[c.id] ?? [c.status]} />
          </li>
        ))}
      </ul>
      <dl className="grid gap-px overflow-hidden rounded-md border border-rule bg-rule sm:grid-cols-3">
        {[
          ["同步佇列", `${data.syncQueue.pending} 筆等待中`],
          ["同步失敗", `${data.syncQueue.failed} 筆`],
          [
            "最舊的等待",
            data.syncQueue.oldestPendingSeconds === null
              ? "—"
              : `${data.syncQueue.oldestPendingSeconds} 秒`,
          ],
        ].map(([k, v]) => (
          <div key={k} className="bg-bg p-5">
            <dt className="zone text-sm text-ink-muted">{k}</dt>
            <dd className="zone mt-1 text-step-2 font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      {data.syncQueue.batching ? <BatchingNote batching={data.syncQueue.batching} /> : null}
      <p className="zone text-sm text-ink-muted">
        最後一次與 DNS 供應商對帳：
        {data.lastReconcileAt ? formatDateTime(data.lastReconcileAt) : "尚未執行"}
      </p>
    </div>
  );
}

/** DNS 供應商有每日批次上限時（Lazco DNS），變更會聚合成批次寫入 */
function BatchingNote({ batching }: { batching: SyncBatching }) {
  const paused = batching.pausedUntil && Date.parse(batching.pausedUntil) > Date.now();
  if (batching.dailyBudget === 0) {
    return (
      <p className="text-sm text-ink-muted" data-testid="sync-batching">
        DNS 變更沒有每日上限，連續編輯會在安靜 10 秒後合併寫入，兩批之間至少間隔{" "}
        {batching.intervalSeconds} 秒。
      </p>
    );
  }
  return (
    <p className="text-sm text-ink-muted" data-testid="sync-batching">
      DNS 變更以批次寫入，約每 {Math.max(1, Math.round(batching.intervalSeconds / 60))}{" "}
      分鐘一批（今日已用 {batching.batchesToday}／{batching.dailyBudget} 批）。
      {paused && batching.pausedUntil
        ? `今日額度已用完，新的變更會在 ${formatDateTime(batching.pausedUntil)} 之後寫入。`
        : batching.nextBatchAt
          ? `下一批最早 ${formatDateTime(batching.nextBatchAt)}。`
          : null}
    </p>
  );
}

function UptimeBar({ statuses }: { statuses: ComponentStatus[] }) {
  const slots = Array.from({ length: 90 }, (_, i) => statuses[statuses.length - 90 + i]);
  const ok = statuses.filter((s) => s === "operational").length;
  return (
    <div className="mt-3">
      <div
        className="flex h-7 gap-[2px]"
        role="img"
        aria-label={`最近 ${statuses.length} 次檢查中有 ${ok} 次正常`}
      >
        {slots.map((s, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 固定 90 格的時間槽
            key={i}
            className={cn(
              "flex-1 rounded-[2px]",
              s === undefined
                ? "bg-surface-2"
                : s === "operational"
                  ? "bg-signal"
                  : s === "degraded"
                    ? "bg-amber"
                    : "bg-danger",
            )}
          />
        ))}
      </div>
      <p className="zone mt-1 flex justify-between text-[0.7rem] text-ink-muted">
        <span>90 次前</span>
        <span>現在</span>
      </p>
    </div>
  );
}
