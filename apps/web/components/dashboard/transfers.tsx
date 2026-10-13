"use client";

import type { Transfer } from "@dit/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/app/avatar.tsx";
import { PageBody, PageHeader } from "@/components/app/page-header.tsx";
import { Button } from "@/components/ui/button.tsx";
import { api, isNotImplemented } from "@/lib/api/client.ts";
import { cn } from "@/lib/cn.ts";
import { errorMessage } from "@/lib/errors.ts";
import { t } from "@/lib/i18n/zh-Hant.ts";
import { q } from "@/lib/queries.ts";
import { formatDateTime } from "@/lib/time.ts";

export function TransfersPage() {
  const { data, error, isPending } = useQuery(q.transfers());
  return (
    <PageBody>
      <PageHeader
        eyebrow="transfers"
        title="擁有權轉移"
        description="收到的與送出的轉移邀請。對方需在 7 天內接受。"
      />
      {error && isNotImplemented(error) ? (
        <p className="mt-8 text-ink-muted" data-testid="transfers-coming-soon">
          擁有權轉移即將推出。
        </p>
      ) : error ? (
        <p className="mt-8 text-danger">{errorMessage(error)}</p>
      ) : isPending ? (
        <p className="mt-8 text-ink-muted">載入中…</p>
      ) : (
        <div className="mt-8 grid gap-10 lg:grid-cols-2">
          <TransferList title="收到的" items={data.incoming} direction="incoming" />
          <TransferList title="送出的" items={data.outgoing} direction="outgoing" />
        </div>
      )}
    </PageBody>
  );
}

function TransferList({
  title,
  items,
  direction,
}: {
  title: string;
  items: Transfer[];
  direction: "incoming" | "outgoing";
}) {
  return (
    <section aria-labelledby={`${direction}-title`}>
      <h2 id={`${direction}-title`} className="text-step-1 font-semibold">
        {title}
        <span className="zone ml-2 text-sm text-ink-muted">({items.length})</span>
      </h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">沒有{title}轉移。</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((tr) => (
            <TransferItem key={tr.id} transfer={tr} direction={direction} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TransferItem({
  transfer: tr,
  direction,
}: {
  transfer: Transfer;
  direction: "incoming" | "outgoing";
}) {
  const queryClient = useQueryClient();
  const act = useMutation({
    mutationFn: (action: "acceptTransfer" | "declineTransfer" | "cancelTransfer") =>
      api(action, { params: { transferId: tr.id } }),
    onSuccess: (next) => {
      queryClient.invalidateQueries({ queryKey: ["listTransfers"] });
      queryClient.invalidateQueries({ queryKey: ["listSubdomains"] });
      queryClient.invalidateQueries({ queryKey: ["getMe"] });
      toast(`轉移${t.transferStatus[next.status]}`);
    },
    onError: (e) => toast.error("操作失敗", { description: errorMessage(e) }),
  });
  const pending = tr.status === "pending";
  return (
    <li
      className={cn(
        "rounded-md border p-4",
        pending ? "border-magpie shadow-[3px_3px_0_var(--magpie)]" : "border-rule",
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="zone text-step-1 font-semibold">{tr.subdomain}.dev-in.tw</span>
        <span className={cn("zone text-xs", pending ? "text-amber" : "text-ink-muted")}>
          [ {t.transferStatus[tr.status]} ]
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <Avatar src={tr.from.avatarUrl} login={tr.from.githubLogin} size={22} />
        <span className="zone">@{tr.from.githubLogin}</span>
        <ArrowRight className="size-4 text-ink-muted" aria-label="轉給" />
        <Avatar src={tr.to.avatarUrl} login={tr.to.githubLogin} size={22} />
        <span className="zone">@{tr.to.githubLogin}</span>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        {tr.keepRecords ? "保留現有紀錄" : "轉移時清空紀錄"} · 建立於 {formatDateTime(tr.createdAt)}
        {pending ? ` · ${formatDateTime(tr.expiresAt)} 到期` : ""}
      </p>
      {pending ? (
        <div className="mt-4 flex gap-2">
          {direction === "incoming" ? (
            <>
              <Button
                size="sm"
                onClick={() => act.mutate("acceptTransfer")}
                disabled={act.isPending}
              >
                接受
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => act.mutate("declineTransfer")}
                disabled={act.isPending}
              >
                拒絕
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => act.mutate("cancelTransfer")}
              disabled={act.isPending}
            >
              取消轉移
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}
