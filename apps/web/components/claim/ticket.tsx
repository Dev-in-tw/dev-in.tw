"use client";

import type { Subdomain } from "@dit/contract";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { type ReactNode, ViewTransition } from "react";
import { SubdomainBadge } from "@/components/app/status-badge.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { api, isNotImplemented } from "@/lib/api/client.ts";
import { cn } from "@/lib/cn.ts";
import { formatDateTime } from "@/lib/time.ts";
import { useReducedMotion } from "@/lib/use-reduced-motion.ts";
import { QrCode } from "./qr.tsx";

/**
 * 開通票券（§4.4 #4）：申請成功後卡片翻面，背面是一張像台鐵名片式車票的票券。
 * 右側存根的「傳播中」進度環由真實的 propagation API 驅動，每 3 秒輪詢，四個 resolver 都看到才畫滿。
 * reduced-motion：不翻面，直接顯示票券；進度環改成文字百分比。
 */
export function TicketStage({
  front,
  subdomain,
  serial,
  githubLogin,
}: {
  front: ReactNode;
  subdomain: Subdomain | null;
  serial: number | null;
  githubLogin: string;
}) {
  const reduced = useReducedMotion();
  const flipped = Boolean(subdomain);

  if (reduced) {
    return subdomain ? (
      <Ticket subdomain={subdomain} serial={serial} githubLogin={githubLogin} reduced />
    ) : (
      front
    );
  }

  return (
    <div className="ticket-stage">
      <div className="ticket-card relative grid" data-flipped={flipped}>
        <div className="ticket-face col-start-1 row-start-1" aria-hidden={flipped} inert={flipped}>
          {front}
        </div>
        <div
          className="ticket-face ticket-back col-start-1 row-start-1"
          aria-hidden={!flipped}
          inert={!flipped}
        >
          {subdomain ? (
            <Ticket
              subdomain={subdomain}
              serial={serial}
              githubLogin={githubLogin}
              reduced={false}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Ticket({
  subdomain,
  serial,
  githubLogin,
  reduced,
}: {
  subdomain: Subdomain;
  serial: number | null;
  githubLogin: string;
  reduced: boolean;
}) {
  const active = subdomain.status === "active";
  return (
    <section
      aria-labelledby="ticket-title"
      className="relative grid overflow-hidden rounded-[var(--radius-dialog)] border border-magpie bg-bg shadow-[6px_6px_0_var(--magpie)] md:grid-cols-[1fr_auto]"
    >
      <div className="relative p-6 sm:p-8">
        <div className="flex items-center justify-between gap-4">
          <p className="zone text-xs font-semibold tracking-[0.3em] text-magpie">
            DEV-IN.TW · 開通票券
          </p>
          <p className="zone text-xs text-ink-muted" data-testid="ticket-serial">
            No. {serial === null ? "——" : String(serial).padStart(6, "0")}
          </p>
        </div>
        <h2 id="ticket-title" className="mt-6">
          <span className="sr-only">開通成功：</span>
          <ViewTransition name={`sub-${subdomain.name}`} share="morph" default="none">
            <span className="zone block text-step-4 font-bold tracking-tight break-all">
              {subdomain.name}
              <span className="text-ink-muted">.dev-in.tw</span>
            </span>
          </ViewTransition>
        </h2>
        <dl className="zone mt-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-ink-muted">自</dt>
          <dd>github.com/{githubLogin}</dd>
          <dt className="text-ink-muted">至</dt>
          <dd className="break-all">{subdomain.fqdn}</dd>
          <dt className="text-ink-muted">{active ? "開通" : "申請"}</dt>
          <dd>{formatDateTime(subdomain.activatedAt ?? subdomain.createdAt)}</dd>
          <dt className="text-ink-muted">狀態</dt>
          <dd>
            <SubdomainBadge status={subdomain.status} />
          </dd>
        </dl>
        {active ? (
          <p className="mt-6 text-sm text-ink-muted">
            名字是你的了。下一步：新增一筆 DNS 紀錄，或一鍵套用 GitHub Pages、Vercel 等設定。
          </p>
        ) : (
          <p className="mt-6 text-sm text-ink-muted">
            這個名稱需要人工審核（通常一天內），結果會顯示在控制台。審核通過前還不能新增紀錄。
          </p>
        )}
        <Link
          href={`/dashboard/${subdomain.name}`}
          className={cn(buttonVariants({ size: "lg" }), "mt-6")}
        >
          設定 DNS
          <ArrowRight aria-hidden />
        </Link>
      </div>

      {/* 存根：齒孔線與兩個半圓缺口 */}
      <div className="relative border-t border-dashed border-magpie/50 p-6 md:border-t-0 md:border-l md:p-8">
        <span
          aria-hidden
          className="absolute -top-3 -left-3 hidden size-6 rounded-full border border-magpie bg-bg md:block"
        />
        <span
          aria-hidden
          className="absolute -bottom-3 -left-3 hidden size-6 rounded-full border border-magpie bg-bg md:block"
        />
        <div className="flex items-center gap-6 md:flex-col">
          <QrCode
            value={`https://${subdomain.fqdn}`}
            className="size-28 rounded-sm"
            label={`連到 ${subdomain.fqdn} 的 QR code`}
          />
          {active ? <PropagationRing name={subdomain.name} reduced={reduced} /> : null}
        </div>
      </div>
    </section>
  );
}

function PropagationRing({ name, reduced }: { name: string; reduced: boolean }) {
  const { data, error } = useQuery({
    queryKey: ["ticket-propagation", name],
    queryFn: ({ signal }) =>
      api("getPropagation", { params: { name }, query: { recordName: "@", type: "A" }, signal }),
    refetchInterval: (query) => {
      const seen = query.state.data?.resolvers.filter((r) => r.matches).length ?? 0;
      return seen >= 4 || query.state.error ? false : 3000;
    },
  });
  if (error && isNotImplemented(error)) {
    return <p className="zone text-xs text-ink-muted">傳播檢查即將推出</p>;
  }
  const total = data?.resolvers.length || 4;
  const seen = data?.resolvers.filter((r) => r.matches).length ?? 0;
  const pct = Math.round((seen / total) * 100);
  const done = seen >= total;

  return (
    <div className="text-center" data-testid="propagation">
      {reduced ? (
        <p className="zone text-step-2 font-semibold text-magpie">{pct}%</p>
      ) : (
        <svg viewBox="0 0 44 44" className="mx-auto size-20 -rotate-90" aria-hidden="true">
          <circle cx="22" cy="22" r="18" fill="none" stroke="var(--rule)" strokeWidth="4" />
          <circle
            cx="22"
            cy="22"
            r="18"
            fill="none"
            stroke={done ? "var(--signal)" : "var(--magpie)"}
            strokeWidth="4"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="100"
            strokeDashoffset={100 - pct}
            style={{ transition: "stroke-dashoffset 700ms var(--ease-out), stroke 300ms" }}
          />
        </svg>
      )}
      <p className="zone mt-2 text-xs text-ink-muted" aria-live="polite">
        {done ? "全球 DNS 都看得到了" : `傳播中 ${seen}/${total}`}
      </p>
    </div>
  );
}
