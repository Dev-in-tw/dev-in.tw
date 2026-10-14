"use client";

import type { AdminReport, ReportStatus } from "@dit/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/field.tsx";
import { api } from "@/lib/api/client.ts";
import { errorMessage } from "@/lib/errors.ts";
import { t } from "@/lib/i18n/zh-Hant.ts";
import { formatDateTime } from "@/lib/time.ts";
import { Chip, ListState, useAdminList } from "./common.tsx";
import { ReasonDialog } from "./reason-dialog.tsx";

export function ReportsQueue() {
  const [status, setStatus] = useState<ReportStatus | "">("open");
  const list = useAdminList("adminListReports", status ? { status } : {});
  const items = (list.data?.pages.flatMap((p) => p.items) ?? []) as AdminReport[];
  const queryClient = useQueryClient();
  const [action, setAction] = useState<{
    report: AdminReport;
    kind: "actioned" | "dismissed";
  } | null>(null);
  const resolve = useMutation({
    mutationFn: ({
      report,
      kind,
      note,
    }: {
      report: AdminReport;
      kind: "actioned" | "dismissed";
      note: string;
    }) =>
      api("adminResolveReport", {
        params: { reportId: report.id },
        body: { status: kind, resolutionNote: note, suspendSubdomain: kind === "actioned" },
      }),
    onSuccess: (r) => {
      toast.success(r.status === "actioned" ? `已停權 ${r.subdomain} 並結案` : "已駁回檢舉");
      setAction(null);
      queryClient.invalidateQueries({ queryKey: ["adminListReports"] });
      queryClient.invalidateQueries({ queryKey: ["adminOverview"] });
    },
  });

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-step-3 font-semibold tracking-tight">檢舉佇列</h1>
        <div className="flex items-center gap-2">
          <label htmlFor="report-status" className="text-sm text-ink-muted">
            狀態
          </label>
          <Select
            id="report-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as ReportStatus | "")}
            className="h-9 w-36 text-sm"
          >
            <option value="open">未處理</option>
            <option value="actioned">已處置</option>
            <option value="dismissed">已駁回</option>
            <option value="">全部</option>
          </Select>
        </div>
      </div>
      <div className="mt-6">
        <ListState query={list} empty={items.length === 0}>
          <ul className="space-y-3">
            {items.map((r) => (
              <li key={r.id} className="rounded-md border border-rule bg-bg p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/admin/subdomains?q=${r.subdomain}`}
                    className="zone text-step-1 font-semibold hover:text-magpie"
                  >
                    {r.subdomain}.dev-in.tw
                  </Link>
                  <Chip tone="danger">{t.reportCategory[r.category]}</Chip>
                  {!r.subdomainExists ? <Chip>子網域已不存在</Chip> : null}
                  <span className="zone ml-auto text-xs text-ink-muted">
                    {formatDateTime(r.createdAt)}
                  </span>
                </div>
                {r.redactedAt ? (
                  <p className="mt-3 text-sm text-ink-muted" data-testid="report-redacted">
                    結案已滿保存期限，說明內容、聯絡 email 與檢舉人資料已於{" "}
                    {formatDateTime(r.redactedAt)} 清除。
                  </p>
                ) : (
                  <p className="mt-3 text-sm whitespace-pre-wrap">{r.details}</p>
                )}
                <p className="zone mt-2 text-xs text-ink-muted">
                  聯絡：{r.redactedAt ? "已清除" : (r.contactEmail ?? "未提供")}
                  {r.handledBy
                    ? ` · 由 @${r.handledBy.githubLogin} 處理：${r.resolutionNote ?? ""}`
                    : ""}
                </p>
                {r.status === "open" ? (
                  <div className="mt-4 flex gap-2">
                    <Button
                      size="sm"
                      variant="danger-solid"
                      onClick={() => setAction({ report: r, kind: "actioned" })}
                      disabled={!r.subdomainExists}
                    >
                      停權並結案
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setAction({ report: r, kind: "dismissed" })}
                    >
                      駁回
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </ListState>
      </div>
      <ReasonDialog
        open={Boolean(action)}
        onOpenChange={(v) => !v && setAction(null)}
        title={
          action?.kind === "actioned" ? `停權 ${action.report.subdomain}.dev-in.tw` : "駁回檢舉"
        }
        description={
          action?.kind === "actioned" ? "DNS 上的紀錄會撤下，資料庫保留，可以再解除。" : undefined
        }
        confirmLabel={action?.kind === "actioned" ? "停權並結案" : "駁回"}
        danger={action?.kind === "actioned"}
        pending={resolve.isPending}
        error={resolve.isError ? errorMessage(resolve.error) : null}
        onSubmit={(note) => action && resolve.mutate({ ...action, note })}
      />
    </div>
  );
}
