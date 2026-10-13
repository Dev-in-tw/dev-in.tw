import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        {eyebrow ? (
          <p className="zone text-sm text-ink-muted">
            <span className="text-beak" aria-hidden>
              ;{" "}
            </span>
            {eyebrow}
          </p>
        ) : null}
        <h1 className="mt-1 text-step-3 font-semibold tracking-tight">{title}</h1>
        {description ? <div className="mt-1 text-ink-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto max-w-6xl px-4 py-8 sm:px-8 lg:py-10", className)}>{children}</div>
  );
}

export function Meter({
  used,
  limit,
  label,
  className,
}: {
  used: number;
  limit: number;
  label: string;
  className?: string;
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = pct >= 95 ? "bg-danger" : pct >= 80 ? "bg-amber" : "bg-magpie";
  return (
    <div className={cn("min-w-40", className)}>
      <div className="zone flex items-baseline justify-between gap-3 text-sm">
        <span className="text-ink-muted">{label}</span>
        <span className="font-semibold tabular-nums">
          {used}
          <span className="text-ink-muted">/{limit}</span>
        </span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: 原生 <meter> 在各瀏覽器無法一致地套用品牌樣式 */}
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-700 ease-out", tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
