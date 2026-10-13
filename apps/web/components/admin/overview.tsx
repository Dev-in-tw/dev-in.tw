"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Meter } from "@/components/app/page-header.tsx";
import { api } from "@/lib/api/client.ts";
import { errorMessage } from "@/lib/errors.ts";

export function AdminOverview() {
  const { data, error } = useQuery({
    queryKey: ["adminOverview"],
    queryFn: () => api("adminOverview"),
  });
  if (error) return <p className="text-danger">{errorMessage(error)}</p>;
  const cards = [
    {
      label: "待審子網域",
      value: data?.pendingReview,
      href: "/admin/review",
      alert: (data?.pendingReview ?? 0) > 0,
    },
    {
      label: "未處理檢舉",
      value: data?.openReports,
      href: "/admin/reports",
      alert: (data?.openReports ?? 0) > 0,
    },
    {
      label: "同步失敗",
      value: data?.failedSyncs,
      href: "/admin/zone",
      alert: (data?.failedSyncs ?? 0) > 0,
    },
    { label: "使用者", value: data?.users, href: "/admin/users" },
    { label: "子網域", value: data?.subdomains, href: "/admin/subdomains" },
  ];
  return (
    <div className="space-y-8">
      <h1 className="text-step-3 font-semibold tracking-tight">後台總覽</h1>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map((c) => (
          <li key={c.label}>
            <Link
              href={c.href}
              className="block rounded-md border border-rule bg-bg p-4 shadow-[4px_4px_0_var(--shadow)] transition-colors hover:border-field"
            >
              <p className="zone text-sm text-ink-muted">{c.label}</p>
              <p className={`zone mt-1 text-step-3 font-semibold ${c.alert ? "text-beak" : ""}`}>
                {c.value ?? "—"}
              </p>
            </Link>
          </li>
        ))}
      </ul>
      {data ? (
        <div className="max-w-md rounded-md border border-rule bg-bg p-5">
          <Meter label="zone 紀錄用量" used={data.zone.used} limit={data.zone.limit} />
          <p className="mt-2 text-xs text-ink-muted">
            Free zone（2023-05-11 建立）上限 1,000 筆，含系統紀錄。≥ 80% 會在 Discord 告警。
          </p>
        </div>
      ) : null}
    </div>
  );
}
