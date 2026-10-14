"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Meter } from "@/components/app/page-header.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog.tsx";
import { Input, Label } from "@/components/ui/field.tsx";
import { api, isNotImplemented } from "@/lib/api/client.ts";
import { errorMessage } from "@/lib/errors.ts";
import { formatDateTime } from "@/lib/time.ts";
import { Chip, DataTable } from "./common.tsx";

const DRIFT_LABEL = {
  missing: "遺失",
  modified: "內容不同",
  orphan: "孤兒",
  unmanaged: "未受管",
} as const;

export function AdminZone() {
  const queryClient = useQueryClient();
  const zone = useQuery({ queryKey: ["adminZone"], queryFn: () => api("adminZone") });
  const [typed, setTyped] = useState("");
  const id = useId();
  const reconcile = useMutation({
    mutationFn: (force: boolean) =>
      api("adminReconcile", { query: { force: force ? "true" : "false" } }),
    onSuccess: (_, force) => {
      toast.success(force ? "已強制對帳（略過大量刪除煞車）" : "已排入對帳");
      setTyped("");
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["adminZone"] }), 1500);
    },
    onError: (e) => toast.error("對帳失敗", { description: errorMessage(e) }),
  });
  const retry = useMutation({
    mutationFn: (jobId: number) => api("adminRetrySyncJob", { params: { jobId: String(jobId) } }),
    onSuccess: (_, jobId) => {
      toast.success(`已重新排入 #${jobId}`);
      queryClient.invalidateQueries({ queryKey: ["adminZone"] });
    },
    onError: (e) => toast.error("重新排入失敗", { description: errorMessage(e) }),
  });

  if (zone.error) {
    return (
      <p className="text-ink-muted">
        {isNotImplemented(zone.error) ? "Zone 儀表即將推出。" : errorMessage(zone.error)}
      </p>
    );
  }
  if (!zone.data) return <p className="text-ink-muted">載入中…</p>;
  const z = zone.data;
  const orphans = z.drift.filter((d) => d.kind === "orphan").length;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-step-3 font-semibold tracking-tight">Zone 儀表</h1>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => reconcile.mutate(false)}
            disabled={reconcile.isPending}
          >
            <RefreshCw aria-hidden />
            立即對帳
          </Button>
          <Dialog onOpenChange={() => setTyped("")}>
            <DialogTrigger asChild>
              <Button variant="danger">強制對帳</Button>
            </DialogTrigger>
            <DialogContent
              title="略過大量刪除煞車？"
              description="只在確認 DATABASE_URL、資料庫內容都正確時使用。孤兒紀錄會被直接刪除。"
            >
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  reconcile.mutate(true);
                }}
              >
                <Label htmlFor={`${id}-force`}>
                  輸入 <span className="zone font-semibold">force</span> 確認
                </Label>
                <Input
                  id={`${id}-force`}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="zone"
                  autoComplete="off"
                />
                <Button
                  type="submit"
                  variant="danger-solid"
                  className="w-full"
                  disabled={typed !== "force" || reconcile.isPending}
                >
                  強制執行對帳
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-md border border-rule bg-bg p-5 md:col-span-2">
          <Meter
            label={`紀錄用量（${z.plan ?? "未知方案"}）`}
            used={z.usage.used}
            limit={z.usage.limit}
          />
          <p className="zone mt-3 text-xs text-ink-muted">
            系統 {z.systemRecords} · 受管 {z.managedRecords} · 最後對帳{" "}
            {z.lastReconcileAt ? formatDateTime(z.lastReconcileAt) : "從未"}
          </p>
        </div>
        {orphans > 0 ? (
          <div role="alert" className="rounded-md border border-danger bg-danger-soft p-5 text-sm">
            <p className="flex items-center gap-2 font-semibold text-danger">
              <TriangleAlert className="size-4" aria-hidden />
              {orphans} 筆孤兒紀錄待確認
            </p>
            <p className="mt-1">超過煞車門檻時對帳會整輪中止；確認無誤後才用「強制對帳」放行。</p>
          </div>
        ) : null}
      </div>
      <section aria-labelledby="drift-title">
        <h2 id="drift-title" className="text-step-1 font-semibold">
          漂移報告（{z.drift.length}）
        </h2>
        <div className="mt-3">
          {z.drift.length === 0 ? (
            <p className="text-sm text-ink-muted">沒有漂移，DB 與 DNS 供應商一致。</p>
          ) : (
            <DataTable label="漂移報告" head={["種類", "FQDN", "類型", "說明"]}>
              {z.drift.map((d) => (
                <tr key={`${d.kind}-${d.fqdn}-${d.type}`}>
                  <td className="px-3 py-2.5">
                    <Chip
                      tone={
                        d.kind === "orphan" ? "danger" : d.kind === "unmanaged" ? "amber" : "muted"
                      }
                    >
                      {DRIFT_LABEL[d.kind]}
                    </Chip>
                  </td>
                  <td className="zone px-3 py-2.5">{d.fqdn}</td>
                  <td className="zone px-3 py-2.5">{d.type}</td>
                  <td className="px-3 py-2.5 text-ink-muted">{d.detail}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      </section>
      <section aria-labelledby="dead-title">
        <h2 id="dead-title" className="text-step-1 font-semibold">
          Dead jobs（{z.deadJobs.length}）
        </h2>
        <div className="mt-3">
          {z.deadJobs.length === 0 ? (
            <p className="text-sm text-ink-muted">沒有失敗的同步工作。</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-ink-muted">
                purge_subdomain
                失敗時子網域會停在「釋出中」，擁有者若申請刪除帳號，帳號資料也要等清除完成才會刪除。
                系統每小時會自動以退避重新排入；確認 DNS 服務恢復後，也可以手動重新排入。
              </p>
              <DataTable
                label="失敗的同步工作"
                head={["#", "種類", "最後錯誤", "更新時間", "操作"]}
              >
                {z.deadJobs.map((j) => (
                  <tr key={j.id}>
                    <td className="zone px-3 py-2.5">{j.id}</td>
                    <td className="zone px-3 py-2.5">{j.kind}</td>
                    <td className="zone px-3 py-2.5 text-danger">{j.lastError ?? "—"}</td>
                    <td className="zone px-3 py-2.5 text-ink-muted">
                      {formatDateTime(j.updatedAt)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => retry.mutate(j.id)}
                        disabled={retry.isPending}
                        aria-label={`重新排入 #${j.id}`}
                      >
                        <RotateCcw aria-hidden />
                        重新排入
                      </Button>
                    </td>
                  </tr>
                ))}
              </DataTable>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
