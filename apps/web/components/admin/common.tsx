"use client";

import type { RequestOf, ResponseOf } from "@dit/contract";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { api, isNotImplemented } from "@/lib/api/client.ts";
import { cn } from "@/lib/cn.ts";
import { errorMessage } from "@/lib/errors.ts";

type PagedName =
  | "adminListUsers"
  | "adminListSubdomains"
  | "adminListReports"
  | "adminListReserved"
  | "adminAuditLog";

/** cursor 分頁的後台清單（「載入更多」） */
export function useAdminList<N extends PagedName>(
  name: N,
  query: NonNullable<RequestOf<N>["query"]>,
) {
  return useInfiniteQuery({
    queryKey: [name, null, query],
    queryFn: ({ pageParam, signal }) =>
      api(name, {
        query: { ...query, cursor: pageParam ?? undefined, limit: 50 },
        signal,
      } as RequestOf<N>) as Promise<
        ResponseOf<N> & { items: unknown[]; nextCursor: string | null }
      >,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function ListState({
  query,
  empty,
  children,
}: {
  query: {
    isPending: boolean;
    error: unknown;
    hasNextPage?: boolean;
    fetchNextPage?: () => unknown;
    isFetchingNextPage?: boolean;
  };
  empty: boolean;
  children: ReactNode;
}) {
  if (query.isPending) return <p className="text-ink-muted">載入中…</p>;
  if (query.error) {
    return (
      <p className={cn(isNotImplemented(query.error) ? "text-ink-muted" : "text-danger")}>
        {errorMessage(query.error)}
      </p>
    );
  }
  if (empty) return <p className="text-ink-muted">;; 沒有資料</p>;
  return (
    <>
      {children}
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-4"
          onClick={() => query.fetchNextPage?.()}
          disabled={query.isFetchingNextPage}
        >
          載入更多
        </Button>
      ) : null}
    </>
  );
}

export function Chip({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "amber" | "danger" | "signal" | "magpie";
}) {
  const cls = {
    muted: "border-rule text-ink-muted",
    amber: "border-amber text-amber",
    danger: "border-danger text-danger",
    signal: "border-signal text-signal",
    magpie: "border-magpie text-magpie",
  }[tone];
  return (
    <span
      className={cn(
        "zone inline-flex items-center rounded border px-1.5 py-0.5 text-[0.72rem]",
        cls,
      )}
    >
      {children}
    </span>
  );
}

export function DataTable({
  head,
  children,
  label,
}: {
  head: string[];
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-rule bg-bg shadow-[4px_4px_0_var(--shadow)]">
      <table className="w-full min-w-[42rem] border-collapse text-sm">
        <caption className="sr-only">{label}</caption>
        <thead className="bg-surface text-left text-xs font-semibold tracking-wide text-ink-muted">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="zone px-3 py-2.5 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">{children}</tbody>
      </table>
    </div>
  );
}

export function ageDays(iso: string): number {
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
}
