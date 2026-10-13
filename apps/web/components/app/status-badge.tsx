import type { SubdomainStatus, SyncStatus } from "@dit/contract";
import { AlertTriangle, Check, CircleSlash, Clock, Loader, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { t } from "@/lib/i18n/zh-Hant.ts";

/**
 * zone file 寫法的狀態徽章：`[ SYNCED ✓ ]`。方括號加等寬字型，搭配圖示與文字，不只靠顏色辨識。
 */
function Bracket({
  tone,
  icon,
  label,
  spoken,
  className,
  scan,
}: {
  tone: "signal" | "amber" | "danger" | "muted" | "magpie";
  icon: ReactNode;
  label: string;
  spoken: string;
  className?: string;
  scan?: boolean;
}) {
  const color = {
    signal: "text-signal",
    amber: "text-amber",
    danger: "text-danger",
    muted: "text-ink-muted",
    magpie: "text-magpie",
  }[tone];
  return (
    <span
      className={cn(
        "zone inline-flex items-center gap-1 whitespace-nowrap text-[0.78rem] font-semibold tracking-wide",
        color,
        scan && "sync-scan",
        className,
      )}
    >
      <span aria-hidden className="opacity-60">
        [
      </span>
      <span aria-hidden>{label}</span>
      <span className="sr-only">{spoken}</span>
      <span aria-hidden className="inline-flex [&_svg]:size-3.5">
        {icon}
      </span>
      <span aria-hidden className="opacity-60">
        ]
      </span>
    </span>
  );
}

export function SyncBadge({ status, className }: { status: SyncStatus; className?: string }) {
  const map = {
    pending: { tone: "amber", icon: <Loader className="motion-safe:animate-spin" /> },
    synced: {
      tone: "signal",
      icon: (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="draw-check"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
        >
          <path d="M3 8.5l3 3 7-7" />
        </svg>
      ),
    },
    error: { tone: "danger", icon: <AlertTriangle /> },
    deleting: { tone: "muted", icon: <Trash2 /> },
  } as const;
  const v = map[status];
  return (
    <Bracket
      tone={v.tone}
      icon={v.icon}
      label={t.syncStatus[status]}
      spoken={t.syncStatusSpoken[status]}
      scan={status === "pending"}
      className={className}
    />
  );
}

export function SubdomainBadge({
  status,
  className,
}: {
  status: SubdomainStatus;
  className?: string;
}) {
  const map = {
    active: { tone: "signal", icon: <Check /> },
    pending_review: { tone: "amber", icon: <Clock /> },
    suspended: { tone: "danger", icon: <CircleSlash /> },
    releasing: { tone: "muted", icon: <Trash2 /> },
  } as const;
  const v = map[status];
  return (
    <Bracket
      tone={v.tone}
      icon={v.icon}
      label={t.subdomainStatus[status]}
      spoken={t.subdomainStatusSpoken[status]}
      className={className}
    />
  );
}
