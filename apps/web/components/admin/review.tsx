"use client";

import type { AdminSubdomain } from "@dit/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/app/avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { api } from "@/lib/api/client.ts";
import { cn } from "@/lib/cn.ts";
import { errorMessage } from "@/lib/errors.ts";
import { t } from "@/lib/i18n/zh-Hant.ts";
import { usePreferences } from "@/lib/preferences.tsx";
import { formatDateTime } from "@/lib/time.ts";
import { ageDays, Chip, ListState, useAdminList } from "./common.tsx";
import { ReasonDialog } from "./reason-dialog.tsx";

/** 審核佇列：a 核准、r 駁回、j/k 上下移動（可在設定關閉快捷鍵） */
export function ReviewQueue() {
  const queryClient = useQueryClient();
  const list = useAdminList("adminListSubdomains", { status: "pending_review" });
  const items = (list.data?.pages.flatMap((p) => p.items) ?? []) as AdminSubdomain[];
  const [index, setIndex] = useState(0);
  const [rejecting, setRejecting] = useState<AdminSubdomain | null>(null);
  const { prefs } = usePreferences();
  const current = items[Math.min(index, items.length - 1)];

  const done = () => {
    queryClient.invalidateQueries({ queryKey: ["adminListSubdomains"] });
    queryClient.invalidateQueries({ queryKey: ["adminOverview"] });
  };
  const approve = useMutation({
    mutationFn: (s: AdminSubdomain) =>
      api("adminApproveSubdomain", { params: { name: s.name }, body: {} }),
    onSuccess: (s) => {
      toast.success(`已核准 ${s.fqdn}`);
      done();
    },
    onError: (e) => toast.error("核准失敗", { description: errorMessage(e) }),
  });
  const reject = useMutation({
    mutationFn: ({ s, reason }: { s: AdminSubdomain; reason: string }) =>
      api("adminRejectSubdomain", { params: { name: s.name }, body: { reason } }),
    onSuccess: (s) => {
      toast(`已駁回 ${s.fqdn}`);
      setRejecting(null);
      done();
    },
  });

  useEffect(() => {
    if (!prefs.shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (
        rejecting ||
        el.closest("input, textarea, select, [contenteditable], [role=dialog]") ||
        e.metaKey ||
        e.ctrlKey
      )
        return;
      if (e.key === "j") setIndex((i) => Math.min(i + 1, items.length - 1));
      else if (e.key === "k") setIndex((i) => Math.max(i - 1, 0));
      else if (e.key === "a" && current) approve.mutate(current);
      else if (e.key === "r" && current) setRejecting(current);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prefs.shortcuts, items.length, current, rejecting, approve]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-step-3 font-semibold tracking-tight">審核佇列</h1>
        {prefs.shortcuts ? (
          <p className="text-sm text-ink-muted">
            <Kbd>a</Kbd> 核准 · <Kbd>r</Kbd> 駁回 · <Kbd>j</Kbd>/<Kbd>k</Kbd> 上下
          </p>
        ) : null}
      </div>
      <div className="mt-6">
        <ListState query={list} empty={items.length === 0}>
          <ul className="space-y-3" aria-label="待審子網域">
            {items.map((s, i) => {
              const age = ageDays(s.owner.githubCreatedAt);
              const selected = s === current;
              return (
                <li
                  key={s.name}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "rounded-md border bg-bg p-4 transition-shadow",
                    selected ? "border-magpie shadow-[4px_4px_0_var(--magpie)]" : "border-rule",
                  )}
                  onFocus={() => setIndex(i)}
                >
                  <div className="flex flex-wrap items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="zone text-step-1 font-semibold">{s.fqdn}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {s.reviewReasons.map((r) => (
                          <Chip key={r} tone={r.startsWith("confusable") ? "danger" : "amber"}>
                            {t.reviewReason(r)}
                          </Chip>
                        ))}
                      </div>
                      <p className="mt-2 text-sm text-ink-muted">
                        {s.description || "（沒有描述）"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <Avatar src={s.owner.avatarUrl} login={s.owner.githubLogin} size={28} />
                      <div>
                        <p className="zone">@{s.owner.githubLogin}</p>
                        <p
                          className={cn("zone text-xs", age < 30 ? "text-amber" : "text-ink-muted")}
                        >
                          GitHub 帳號 {age} 天
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => approve.mutate(s)}
                      disabled={approve.isPending}
                    >
                      <Check aria-hidden />
                      核准
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setRejecting(s)}>
                      <X aria-hidden />
                      駁回
                    </Button>
                    <span className="zone ml-auto text-xs text-ink-muted">
                      申請於 {formatDateTime(s.createdAt)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </ListState>
      </div>
      <ReasonDialog
        open={Boolean(rejecting)}
        onOpenChange={(v) => !v && setRejecting(null)}
        title={`駁回 ${rejecting?.fqdn ?? ""}`}
        description="申請人會在控制台看到結果；名稱會進入冷卻期。"
        confirmLabel="駁回申請"
        pending={reject.isPending}
        error={reject.isError ? errorMessage(reject.error) : null}
        onSubmit={(reason) => rejecting && reject.mutate({ s: rejecting, reason })}
      />
    </div>
  );
}
