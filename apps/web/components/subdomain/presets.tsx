"use client";

import type { Preset, PresetPlan, RecordList, Subdomain } from "@dit/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Sparkles, TriangleAlert } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.tsx";
import { FieldError, FieldHint, Input, Label } from "@/components/ui/field.tsx";
import { api, idempotencyKey } from "@/lib/api/client.ts";
import { cn } from "@/lib/cn.ts";
import { errorMessage, fieldErrors } from "@/lib/errors.ts";
import { useMe } from "@/lib/me.tsx";
import { q } from "@/lib/queries.ts";
import { recordValue } from "@/lib/records.ts";

const lineKey = (r: { name: string; type: string } & Record<string, unknown>) =>
  `${r.name}|${r.type}|${recordValue(r as never)}`;

/**
 * 一鍵設定：preset 卡片 → 參數表單 → diff 預覽（+ 新增、- 刪除，逐行 stagger）→ 套用。
 * 套用後 + 行用 Motion 的 layoutId「落」進下方的紀錄清單（FLIP，§4.4 #8）。
 */
export function PresetPanel({
  subdomain,
  initialRecords,
}: {
  subdomain: Subdomain;
  initialRecords: RecordList;
}) {
  const me = useMe();
  const queryClient = useQueryClient();
  const presets = useQuery(q.presets());
  const records = useQuery({ ...q.records(subdomain.name), initialData: initialRecords });
  const [selected, setSelected] = useState<Preset | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [recordName, setRecordName] = useState("@");
  const [plan, setPlan] = useState<PresetPlan | null>(null);
  const [key, setKey] = useState(idempotencyKey);
  const formId = useId();
  const active = subdomain.status === "active";

  const choose = (preset: Preset) => {
    setSelected(preset);
    setPlan(null);
    setKey(idempotencyKey());
    setRecordName("@");
    setParams(
      Object.fromEntries(
        preset.params.map((p) => [p.key, p.defaultFrom === "githubLogin" ? me.githubLogin : ""]),
      ),
    );
  };

  const planMutation = useMutation({
    mutationFn: () =>
      api("planPreset", {
        params: { name: subdomain.name, presetId: selected?.id ?? "github-pages" },
        body: { recordName, params: compact(params) },
      }),
    onSuccess: setPlan,
  });

  const apply = useMutation({
    mutationFn: () =>
      api("applyPreset", {
        params: { name: subdomain.name, presetId: selected?.id ?? "github-pages" },
        body: { recordName, params: compact(params) },
        idempotencyKey: key,
      }),
    onSuccess: (res) => {
      queryClient.setQueryData<RecordList>(q.records(subdomain.name).queryKey, (old) =>
        old
          ? {
              items: [...old.items.filter((r) => !res.deletedIds.includes(r.id)), ...res.created],
              usage: {
                ...old.usage,
                used: old.usage.used - res.deletedIds.length + res.created.length,
              },
            }
          : old,
      );
      queryClient.invalidateQueries({ queryKey: ["getSubdomain"] });
      toast.success(`已套用 ${selected?.title}`, { description: "紀錄同步中，通常一秒內完成。" });
      setPlan(null);
      setSelected(null);
    },
  });

  const paramErrors = planMutation.isError ? fieldErrors(planMutation.error) : {};
  const items = records.data?.items ?? [];

  return (
    <LayoutGroup>
      <section
        aria-labelledby="presets-title"
        className="rounded-md border border-rule bg-bg p-5 shadow-[4px_4px_0_var(--shadow)] sm:p-6"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-magpie" aria-hidden />
          <h2 id="presets-title" className="text-step-1 font-semibold">
            快速設定
          </h2>
        </div>

        {!selected ? (
          <>
            <p className="mt-1 text-sm text-ink-muted">
              選一個平台，填一兩個欄位，就幫你產生需要的紀錄。
            </p>
            <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(presets.data?.items ?? []).map((preset) => (
                <li key={preset.id}>
                  <button
                    type="button"
                    onClick={() => choose(preset)}
                    disabled={!preset.available || !active}
                    className="flex h-full w-full flex-col items-start rounded-md border border-rule p-4 text-left transition-[border-color,box-shadow] hover:border-magpie hover:shadow-[3px_3px_0_var(--magpie)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-rule disabled:hover:shadow-none"
                  >
                    <span className="font-semibold">{preset.title}</span>
                    <span className="mt-1 text-sm text-ink-muted">{preset.description}</span>
                    {!preset.available ? (
                      <span className="zone mt-2 text-xs text-amber">即將推出</span>
                    ) : null}
                  </button>
                </li>
              ))}
              {presets.isPending
                ? [0, 1, 2].map((i) => (
                    <li key={i} className="h-24 animate-pulse rounded-md bg-surface-2" />
                  ))
                : null}
            </ul>
          </>
        ) : (
          <form
            id={formId}
            className="mt-4 space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              planMutation.mutate();
            }}
          >
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
            >
              <ArrowLeft className="size-4" aria-hidden />
              選其他平台
            </button>
            <p className="font-semibold">{selected.title}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-recordName`}>套用在哪個名稱</Label>
                <Input
                  id={`${formId}-recordName`}
                  value={recordName}
                  onChange={(e) => {
                    setRecordName(e.target.value.trim().toLowerCase() || "@");
                    setPlan(null);
                  }}
                  className="zone"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-describedby={`${formId}-recordName-hint`}
                />
                <FieldHint id={`${formId}-recordName-hint`}>
                  @ 代表 {subdomain.fqdn} 本身；填 blog 就是 blog.{subdomain.fqdn}
                </FieldHint>
              </div>
              {selected.params.map((p) => (
                <div key={p.key} className="space-y-1.5">
                  <Label htmlFor={`${formId}-${p.key}`}>
                    {p.label}
                    {p.required ? <span className="text-danger"> *</span> : null}
                  </Label>
                  <Input
                    id={`${formId}-${p.key}`}
                    value={params[p.key] ?? ""}
                    placeholder={p.placeholder}
                    required={p.required}
                    pattern={p.pattern}
                    onChange={(e) => {
                      setParams({ ...params, [p.key]: e.target.value });
                      setPlan(null);
                    }}
                    className="zone"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-invalid={Boolean(paramErrors[p.key])}
                  />
                  <FieldError>{paramErrors[p.key]}</FieldError>
                </div>
              ))}
            </div>
            <FieldError>
              {planMutation.isError ? errorMessage(planMutation.error) : null}
            </FieldError>
            {!plan ? (
              <Button type="submit" variant="secondary" disabled={planMutation.isPending}>
                {planMutation.isPending ? "計算中…" : "預覽變更"}
              </Button>
            ) : null}
          </form>
        )}

        <AnimatePresence>
          {plan && selected ? (
            <motion.div
              key="plan"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-6 space-y-4"
            >
              <section
                className="zone overflow-x-auto rounded-md border border-rule bg-surface p-4 text-sm"
                aria-label="變更預覽"
              >
                {plan.deletes.map((r, i) => (
                  <p
                    key={r.id}
                    className="diff-line flex gap-3 whitespace-nowrap text-danger"
                    style={{ animationDelay: `${i * 30}ms` }}
                  >
                    <span aria-hidden>-</span>
                    <span className="sr-only">刪除</span>
                    <span>{r.name}</span>
                    <span className="font-semibold">{r.type}</span>
                    <span>{recordValue(r)}</span>
                  </p>
                ))}
                {plan.creates.map((r, i) => (
                  <motion.p
                    key={lineKey(r)}
                    layoutId={`rec-${lineKey(r)}`}
                    className="diff-line flex gap-3 whitespace-nowrap text-signal"
                    style={{ animationDelay: `${(plan.deletes.length + i) * 30}ms` }}
                  >
                    <span aria-hidden>+</span>
                    <span className="sr-only">新增</span>
                    <span>{r.name}</span>
                    <span className="font-semibold">{r.type}</span>
                    <span>{recordValue(r)}</span>
                  </motion.p>
                ))}
              </section>
              {plan.warnings.map((w) => (
                <p key={w} className="flex gap-2 text-sm text-amber">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {w}
                </p>
              ))}
              <FieldError>{apply.isError ? errorMessage(apply.error) : null}</FieldError>
              <div className="flex gap-2">
                <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
                  {apply.isPending
                    ? "套用中…"
                    : `套用（+${plan.creates.length} −${plan.deletes.length}）`}
                </Button>
                <Button variant="ghost" onClick={() => setPlan(null)}>
                  修改參數
                </Button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </section>

      <section aria-labelledby="current-title" className="mt-8">
        <h2 id="current-title" className="zone text-sm text-ink-muted">
          <span className="text-beak">;</span> 目前的紀錄（
          {items.filter((r) => r.syncStatus !== "deleting").length}）
        </h2>
        <ul className="zone mt-3 space-y-1 text-sm">
          {items
            .filter((r) => r.syncStatus !== "deleting")
            .map((r) => (
              <motion.li
                key={r.id}
                layoutId={`rec-${lineKey(r)}`}
                className={cn(
                  "flex gap-3 whitespace-nowrap",
                  r.syncStatus === "pending" && "text-amber",
                )}
              >
                <span className="w-32 truncate">{r.name}</span>
                <span className="w-14 font-semibold text-beak">{r.type}</span>
                <span className="min-w-0 truncate text-magpie">{recordValue(r)}</span>
              </motion.li>
            ))}
          {items.length === 0 ? <li className="text-ink-muted">;; 還沒有紀錄</li> : null}
        </ul>
      </section>
    </LayoutGroup>
  );
}

function compact(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, v]) => v.trim() !== "")
      .map(([k, v]) => [k, v.trim()]),
  );
}
