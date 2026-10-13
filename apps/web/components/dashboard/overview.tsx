"use client";

import type { Subdomain } from "@dit/contract";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Inbox, Plus, Settings2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, ViewTransition } from "react";
import { ActivityList } from "@/components/app/activity.tsx";
import { CopyButton } from "@/components/app/copy-button.tsx";
import { GlowCard } from "@/components/app/glow.tsx";
import { Meter, PageBody, PageHeader } from "@/components/app/page-header.tsx";
import { SubdomainBadge } from "@/components/app/status-badge.tsx";
import { ClaimTerminal } from "@/components/claim/terminal.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { api, isNotImplemented } from "@/lib/api/client.ts";
import { cn } from "@/lib/cn.ts";
import { useMe } from "@/lib/me.tsx";
import { q } from "@/lib/queries.ts";
import { greeting, relativeTime } from "@/lib/time.ts";

export function DashboardOverview({ initial }: { initial: Subdomain[] }) {
  const me = useMe();
  const router = useRouter();
  const subs = useQuery({ ...q.subdomains(), initialData: { items: initial } });
  const meta = useQuery(q.meta());
  const transfers = useQuery({ ...q.transfers(), enabled: me.incomingTransfers > 0 });
  const admin = useQuery({
    queryKey: ["adminOverview"],
    queryFn: () => api("adminOverview"),
    enabled: me.role === "admin",
  });
  const items = subs.data?.items ?? [];
  const canClaim = me.quota.subdomains.used < me.quota.subdomains.limit;
  const goClaim = (name: string) =>
    startTransition(() => router.push(`/claim/${encodeURIComponent(name)}`));
  const pendingIncoming = transfers.data?.incoming.filter((t) => t.status === "pending") ?? [];

  return (
    <PageBody>
      <PageHeader
        eyebrow={greeting()}
        title={
          <>
            哈囉，<span className="zone">{me.displayName ?? me.githubLogin}</span>
          </>
        }
        description="你的名字們都在這裡。"
        actions={
          <div className="flex flex-wrap gap-6">
            <Meter
              label="子網域"
              used={me.quota.subdomains.used}
              limit={me.quota.subdomains.limit}
            />
            {admin.data ? (
              <Meter label="zone 容量" used={admin.data.zone.used} limit={admin.data.zone.limit} />
            ) : null}
          </div>
        }
      />

      {meta.data?.zoneNearlyFull ? (
        <p role="status" className="mt-6 rounded-md border border-amber bg-amber-soft p-3 text-sm">
          整個 dev-in.tw 的紀錄容量快滿了（超過 90%）。新增紀錄前請先整理不再使用的紀錄。
        </p>
      ) : null}

      {pendingIncoming.length > 0 ? (
        <Link
          href="/dashboard/transfers"
          className="mt-6 flex items-center gap-3 rounded-md border border-magpie bg-magpie-soft p-4 text-sm hover:shadow-[3px_3px_0_var(--magpie)]"
        >
          <Inbox className="size-5 text-magpie" aria-hidden />
          <span>
            有 {pendingIncoming.length} 個子網域等你接收：
            <span className="zone font-semibold">
              {pendingIncoming.map((t) => t.subdomain).join("、")}
            </span>
          </span>
          <ArrowRight className="ml-auto size-4" aria-hidden />
        </Link>
      ) : null}

      <section aria-labelledby="subs-title" className="mt-10">
        <h2 id="subs-title" className="sr-only">
          我的子網域
        </h2>
        {items.length === 0 ? (
          <div className="rounded-[var(--radius-dialog)] border border-dashed border-field p-6 sm:p-10">
            <p className="zone text-sm text-ink-muted">;; 0 個子網域。來申請你的第一個吧</p>
            <div className="mt-4 max-w-2xl">
              <ClaimTerminal size="md" onSubmit={goClaim} autoFocus />
            </div>
          </div>
        ) : (
          <ul className="grid gap-5 md:grid-cols-2">
            {items.map((sub) => (
              <li key={sub.name}>
                <SubdomainCard sub={sub} />
              </li>
            ))}
            {canClaim ? (
              <li>
                <div className="flex h-full flex-col justify-between gap-4 rounded-md border border-dashed border-field p-5">
                  <p className="flex items-center gap-2 text-sm text-ink-muted">
                    <Plus className="size-4" aria-hidden />
                    還可以再申請 {me.quota.subdomains.limit - me.quota.subdomains.used} 個
                  </p>
                  <ClaimTerminal size="md" onSubmit={goClaim} />
                </div>
              </li>
            ) : null}
          </ul>
        )}
      </section>

      <section aria-labelledby="activity-title" className="mt-14">
        <h2 id="activity-title" className="text-step-1 font-semibold">
          最近活動
        </h2>
        <MyActivity />
      </section>
    </PageBody>
  );
}

function MyActivity() {
  const { data, error, isPending } = useQuery(q.myActivity());
  if (error && isNotImplemented(error)) {
    return <p className="mt-3 text-sm text-ink-muted">活動紀錄即將推出。</p>;
  }
  if (isPending) return <p className="mt-3 text-sm text-ink-muted">載入中…</p>;
  return <ActivityList items={data?.items ?? []} className="mt-4" />;
}

export function SubdomainCard({ sub }: { sub: Subdomain }) {
  const href = `/dashboard/${sub.name}`;
  return (
    <GlowCard className="group relative flex h-full flex-col rounded-md border border-rule bg-bg p-5 shadow-[4px_4px_0_var(--shadow)] transition-[border-color,translate,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-field hover:shadow-[6px_6px_0_var(--shadow)]">
      <div className="flex items-start justify-between gap-3">
        <SubdomainBadge status={sub.status} />
        <span className="zone text-xs text-ink-muted" suppressHydrationWarning>
          更新於 {relativeTime(sub.updatedAt)}
        </span>
      </div>
      <h3 className="mt-4 min-w-0">
        <Link href={href} className="after:absolute after:inset-0 focus-visible:outline-none">
          <ViewTransition name={`sub-${sub.name}`} share="morph" default="none">
            <span className="zone block truncate text-step-2 font-semibold tracking-tight">
              {sub.name}
              <span className="text-ink-muted">.dev-in.tw</span>
            </span>
          </ViewTransition>
        </Link>
      </h3>
      <p className="mt-1 line-clamp-2 min-h-[2.8em] text-sm text-ink-muted">
        {sub.description || "（沒有描述）"}
      </p>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-rule pt-4">
        <span className="zone text-sm">
          {sub.records.used}
          <span className="text-ink-muted">/{sub.records.limit} 筆紀錄</span>
        </span>
        <div className="relative z-10 flex items-center gap-1">
          <CopyButton value={`https://${sub.fqdn}`} label={`複製 ${sub.fqdn} 的網址`} />
          {sub.status === "active" ? (
            <a
              href={`https://${sub.fqdn}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex size-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
              aria-label={`在新分頁開啟 ${sub.fqdn}`}
            >
              <ArrowUpRight className="size-4" aria-hidden />
            </a>
          ) : null}
          <Link
            href={`${href}/records`}
            className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "ml-1")}
          >
            <Settings2 aria-hidden />
            管理 DNS
          </Link>
        </div>
      </div>
      {sub.status === "pending_review" ? (
        <p className="mt-3 text-xs text-amber">審核中，通常一天內完成</p>
      ) : null}
      {sub.status === "suspended" ? (
        <p className="mt-3 text-xs text-danger">已停權：{sub.suspendedReason}</p>
      ) : null}
    </GlowCard>
  );
}
