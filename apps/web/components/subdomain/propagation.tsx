"use client";

import type { RecordList, RecordType, Subdomain } from "@dit/contract";
import { useQuery } from "@tanstack/react-query";
import { Check, Radar, RefreshCw, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/field.tsx";
import { api, isNotImplemented } from "@/lib/api/client.ts";
import { cn } from "@/lib/cn.ts";
import { errorMessage } from "@/lib/errors.ts";
import { q } from "@/lib/queries.ts";
import { formatDateTime } from "@/lib/time.ts";

/**
 * 傳播檢查（P1）：由後端用 DoH 問 Cloudflare、Google、Quad9 與 TWNIC Quad101，
 * 結果以 dig 的 ANSWER SECTION 風格呈現，四顆燈號同時有圖示與文字。
 */
export function PropagationPanel({
  subdomain,
  initialRecords,
}: {
  subdomain: Subdomain;
  initialRecords: RecordList;
}) {
  const records = useQuery({ ...q.records(subdomain.name), initialData: initialRecords });
  const options = Array.from(
    new Map(
      (records.data?.items ?? [])
        .filter((r) => r.syncStatus !== "deleting")
        .map((r) => [`${r.name}|${r.type}`, { name: r.name, type: r.type }]),
    ).values(),
  );
  const [choice, setChoice] = useState<string>(() =>
    options[0] ? `${options[0].name}|${options[0].type}` : "",
  );
  const [recordName = "@", type = "A"] = choice.split("|") as [string?, RecordType?];

  const query = useQuery({
    queryKey: ["getPropagation", { name: subdomain.name }, { recordName, type }],
    queryFn: ({ signal }) =>
      api("getPropagation", {
        params: { name: subdomain.name },
        query: { recordName, type },
        signal,
      }),
    enabled: Boolean(choice) && subdomain.status === "active",
    staleTime: 15_000,
  });

  if (query.error && isNotImplemented(query.error)) {
    return (
      <Shell>
        <p className="mt-2 text-sm text-ink-muted" data-testid="propagation-coming-soon">
          傳播檢查即將推出。在那之前可以用{" "}
          <code className="zone">dig +short {subdomain.fqdn} @1.1.1.1</code> 自己查。
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      {options.length === 0 ? (
        <p className="mt-2 text-sm text-ink-muted">先新增一筆紀錄，才有東西可以檢查。</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <label htmlFor="prop-record" className="sr-only">
              要檢查的紀錄
            </label>
            <Select
              id="prop-record"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="zone h-9 w-auto min-w-48 text-sm"
            >
              {options.map((o) => (
                <option key={`${o.name}|${o.type}`} value={`${o.name}|${o.type}`}>
                  {o.name} {o.type}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw
                className={cn(query.isFetching && "motion-safe:animate-spin")}
                aria-hidden
              />
              重新檢查
            </Button>
          </div>
          {query.isError ? (
            <p className="mt-3 text-sm text-danger">{errorMessage(query.error)}</p>
          ) : null}
          {query.data ? (
            <div className="zone mt-4 overflow-x-auto rounded-md border border-rule bg-surface p-4 text-[0.82rem]">
              <p className="text-ink-muted">;; QUESTION SECTION:</p>
              <p>
                ;{query.data.fqdn}. IN {query.data.type}
              </p>
              <p className="mt-2 text-ink-muted">
                ;; EXPECTED: {query.data.expected.join(" ") || "（無）"}
              </p>
              <ul className="mt-3 space-y-1.5" data-testid="resolvers">
                {query.data.resolvers.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <span
                      className={cn(
                        "inline-flex size-5 items-center justify-center rounded-full",
                        r.matches
                          ? "bg-signal-soft text-signal"
                          : r.error
                            ? "bg-danger-soft text-danger"
                            : "bg-amber-soft text-amber",
                      )}
                      aria-hidden
                    >
                      {r.matches ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                    </span>
                    <span className="w-40 shrink-0">{r.label}</span>
                    <span
                      className={cn(
                        r.matches ? "text-signal" : r.error ? "text-danger" : "text-amber",
                      )}
                    >
                      {r.matches ? "已生效" : r.error ? `錯誤：${r.error}` : "尚未看到"}
                    </span>
                    <span className="text-ink-muted">{r.answers.join(" ")}</span>
                    {r.latencyMs !== null ? (
                      <span className="ml-auto text-ink-muted">{r.latencyMs} ms</span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-ink-muted">
                ;; WHEN: {formatDateTime(query.data.checkedAt)}（結果快取 15 秒）
              </p>
            </div>
          ) : null}
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <section
      aria-labelledby="prop-title"
      className="rounded-md border border-rule bg-bg p-5 shadow-[4px_4px_0_var(--shadow)] sm:p-6"
    >
      <div className="flex items-center gap-2">
        <Radar className="size-5 text-magpie" aria-hidden />
        <h2 id="prop-title" className="text-step-1 font-semibold">
          傳播檢查
        </h2>
      </div>
      {children}
    </section>
  );
}
