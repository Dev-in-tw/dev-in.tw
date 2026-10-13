"use client";

import type { Subdomain } from "@dit/contract";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { type ReactNode, ViewTransition } from "react";
import { CopyButton } from "@/components/app/copy-button.tsx";
import { SubdomainBadge } from "@/components/app/status-badge.tsx";
import { cn } from "@/lib/cn.ts";
import { t } from "@/lib/i18n/zh-Hant.ts";
import { q } from "@/lib/queries.ts";

const TABS = [
  { segment: null, href: "", label: "總覽" },
  { segment: "records", href: "/records", label: "紀錄" },
  { segment: "settings", href: "/settings", label: "設定" },
  { segment: "activity", href: "/activity", label: "活動" },
];

export function SubdomainHeader({ initial }: { initial: Subdomain }) {
  const { data: sub = initial } = useQuery({ ...q.subdomain(initial.name), initialData: initial });
  const segment = useSelectedLayoutSegment();
  const base = `/dashboard/${sub.name}`;

  return (
    <div>
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden />
        所有子網域
      </Link>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="min-w-0">
          <ViewTransition name={`sub-${sub.name}`} share="morph" default="none">
            <span className="zone block text-step-4 font-bold tracking-tight break-all">
              {sub.name}
              <span className="text-ink-muted">.dev-in.tw</span>
            </span>
          </ViewTransition>
        </h1>
        <SubdomainBadge status={sub.status} />
        <div className="ml-auto flex items-center gap-1">
          <CopyButton value={`https://${sub.fqdn}`} label={`複製 ${sub.fqdn} 的網址`} />
          {sub.status === "active" ? (
            <a
              href={`https://${sub.fqdn}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              開啟網站
              <ArrowUpRight className="size-4" aria-hidden />
            </a>
          ) : null}
        </div>
      </div>
      {sub.description ? <p className="mt-2 text-ink-muted">{sub.description}</p> : null}

      <StatusBanner sub={sub} />

      <nav aria-label="子網域分頁" className="mt-6 flex gap-1 overflow-x-auto border-b border-rule">
        {TABS.map((tab) => {
          const active = segment === tab.segment;
          return (
            <Link
              key={tab.label}
              href={`${base}${tab.href}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative -mb-px border-b-2 px-4 py-2.5 text-[0.95rem] whitespace-nowrap transition-colors",
                active
                  ? "border-beak font-medium text-ink"
                  : "border-transparent text-ink-muted hover:text-ink",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function StatusBanner({ sub }: { sub: Subdomain }) {
  let body: ReactNode = null;
  if (sub.status === "pending_review") {
    body = (
      <div className="rounded-md border border-amber bg-amber-soft p-4 text-sm">
        <p className="font-medium">審核中：通過前還不能新增紀錄</p>
        {sub.reviewReasons.length ? (
          <p className="mt-1 text-ink-muted">
            原因：{sub.reviewReasons.map(t.reviewReason).join("、")}
          </p>
        ) : null}
      </div>
    );
  } else if (sub.status === "suspended") {
    body = (
      <div role="alert" className="rounded-md border border-danger bg-danger-soft p-4 text-sm">
        <p className="font-medium text-danger">
          已停權：DNS 紀錄已從 Cloudflare 撤下，但仍保留在系統中
        </p>
        <p className="mt-1">
          {sub.suspendedReason ?? "違反使用規範"}。如有疑問請寫信到 abuse@dev-in.tw。
        </p>
      </div>
    );
  } else if (sub.status === "releasing") {
    body = (
      <div className="rounded-md border border-rule bg-surface p-4 text-sm">
        正在釋出，紀錄清除後名稱會進入 30 天冷卻期。
      </div>
    );
  }
  return body ? <div className="mt-5">{body}</div> : null;
}

/** 分頁內容：切換分頁時以 view transition 滑入（§4.4 #5） */
export function TabPanel({ children }: { children: ReactNode }) {
  const segment = useSelectedLayoutSegment() ?? "overview";
  return (
    <ViewTransition key={segment} enter="slide-in" exit="slide-out" default="none">
      <div className="mt-8">{children}</div>
    </ViewTransition>
  );
}
