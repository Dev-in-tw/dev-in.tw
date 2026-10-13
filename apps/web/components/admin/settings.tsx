"use client";

import type { AdminSettings } from "@dit/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch.tsx";
import { api, isNotImplemented } from "@/lib/api/client.ts";
import { cn } from "@/lib/cn.ts";
import { errorMessage } from "@/lib/errors.ts";

const MODES: { value: AdminSettings["reviewMode"]; label: string; body: string }[] = [
  {
    value: "risk",
    label: "依風險",
    body: "新帳號（< 30 天）或近似品牌的名稱才送審，其餘自動開通。",
  },
  { value: "all", label: "全部審核", body: "所有申請都要人工核准。遭到大量濫用時使用。" },
  { value: "none", label: "不審核", body: "全部自動開通（保留字仍然有效）。" },
];

export function AdminSettingsPanel() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["adminGetSettings"],
    queryFn: () => api("adminGetSettings"),
  });
  const update = useMutation({
    mutationFn: (body: Partial<AdminSettings>) => api("adminUpdateSettings", { body }),
    onSuccess: (next) => {
      queryClient.setQueryData(["adminGetSettings"], next);
      queryClient.invalidateQueries({ queryKey: ["getMeta"] });
      toast.success("系統設定已更新");
    },
    onError: (e) => toast.error("更新失敗", { description: errorMessage(e) }),
  });
  if (settings.error) {
    return (
      <p className="text-ink-muted">
        {isNotImplemented(settings.error) ? "系統設定即將推出。" : errorMessage(settings.error)}
      </p>
    );
  }
  const s = settings.data;
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-step-3 font-semibold tracking-tight">系統設定</h1>
      <section className="flex items-start justify-between gap-6 rounded-md border border-rule bg-bg p-5">
        <div>
          <h2 id="reg-label" className="font-semibold">
            開放註冊
          </h2>
          <p className="text-sm text-ink-muted">
            關閉後新的申請會收到 REGISTRATION_CLOSED，可用性查詢不受影響。zone
            容量耗盡時系統會自動關閉。
          </p>
        </div>
        <Switch
          aria-labelledby="reg-label"
          checked={s?.registrationOpen ?? false}
          disabled={!s || update.isPending}
          onCheckedChange={(v) => update.mutate({ registrationOpen: v })}
        />
      </section>
      <fieldset className="rounded-md border border-rule bg-bg p-5">
        <legend className="px-1 font-semibold">審核模式</legend>
        <div className="mt-2 space-y-2">
          {MODES.map((m) => (
            <label
              key={m.value}
              className={cn(
                "flex cursor-pointer gap-3 rounded-md border p-3 transition-colors",
                s?.reviewMode === m.value
                  ? "border-magpie bg-magpie-soft"
                  : "border-rule hover:bg-surface",
              )}
            >
              <input
                type="radio"
                name="reviewMode"
                value={m.value}
                checked={s?.reviewMode === m.value}
                disabled={!s || update.isPending}
                onChange={() => update.mutate({ reviewMode: m.value })}
                className="mt-1 accent-[var(--magpie)]"
              />
              <span>
                <span className="block font-medium">{m.label}</span>
                <span className="text-sm text-ink-muted">{m.body}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
