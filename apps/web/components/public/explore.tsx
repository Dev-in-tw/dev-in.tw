"use client";

import type { DirectoryEntry } from "@dit/contract";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { Avatar } from "@/components/app/avatar.tsx";
import { GlowCard } from "@/components/app/glow.tsx";
import { LazyTaiwanMap } from "@/components/map/lazy-map.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/field.tsx";
import { api, isNotImplemented } from "@/lib/api/client.ts";
import { q } from "@/lib/queries.ts";
import { formatDate } from "@/lib/time.ts";

/** 公開成員牆：hover 成員卡片時，地圖上對應的點會亮起（P1） */
export function ExploreWall() {
  const [highlight, setHighlight] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const term = useDeferredValue(search.trim().toLowerCase());
  const list = useInfiniteQuery({
    queryKey: ["listDirectory", "infinite"],
    queryFn: ({ pageParam, signal }) =>
      api("listDirectory", {
        query: { limit: 60, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const stats = useQuery(q.stats());
  const items: DirectoryEntry[] = list.data?.pages.flatMap((p) => p.items) ?? [];
  const shown = term
    ? items.filter(
        (m) =>
          m.name.includes(term) ||
          m.owner.githubLogin.toLowerCase().includes(term) ||
          m.description.toLowerCase().includes(term),
      )
    : items;

  if (list.error && isNotImplemented(list.error)) {
    return (
      <p className="mt-10 text-ink-muted" data-testid="explore-coming-soon">
        成員展示即將推出。
      </p>
    );
  }

  return (
    <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_22rem]">
      <div className="min-w-0">
        <label htmlFor="explore-search" className="sr-only">
          搜尋成員
        </label>
        <Input
          id="explore-search"
          data-search
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜尋名稱、帳號或描述（按 / 聚焦）"
          className="max-w-md"
        />
        {list.isPending ? (
          <ul className="mt-6 grid gap-4 sm:grid-cols-2">
            {["s1", "s2", "s3", "s4", "s5", "s6"].map((i) => (
              <li
                key={i}
                className="h-36 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none"
              />
            ))}
          </ul>
        ) : shown.length === 0 ? (
          <p className="mt-6 text-ink-muted">;; 找不到符合的成員</p>
        ) : (
          <ul className="mt-6 grid gap-4 sm:grid-cols-2" aria-label="公開展示的成員">
            {shown.map((m) => (
              <li
                key={m.name}
                onMouseEnter={() => setHighlight(m.name)}
                onMouseLeave={() => setHighlight(null)}
                onFocus={() => setHighlight(m.name)}
                onBlur={() => setHighlight(null)}
              >
                <GlowCard className="relative h-full rounded-md border border-rule bg-bg p-4 shadow-[4px_4px_0_var(--shadow)] transition-[border-color,translate] hover:-translate-y-0.5 hover:border-field">
                  <div className="flex items-center gap-3">
                    <Avatar src={m.owner.avatarUrl} login={m.owner.githubLogin} size={36} />
                    <div className="min-w-0">
                      <a
                        href={`https://${m.fqdn}`}
                        target="_blank"
                        rel="noreferrer"
                        className="zone block truncate font-semibold after:absolute after:inset-0 hover:text-magpie"
                      >
                        {m.fqdn}
                      </a>
                      <p className="zone truncate text-xs text-ink-muted">@{m.owner.githubLogin}</p>
                    </div>
                    <ArrowUpRight className="ml-auto size-4 shrink-0 text-ink-muted" aria-hidden />
                  </div>
                  <p className="mt-3 line-clamp-2 text-sm text-ink-muted">
                    {m.description || "（沒有描述）"}
                  </p>
                  <p className="zone mt-3 text-xs text-ink-muted">since {formatDate(m.since)}</p>
                </GlowCard>
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage ? (
          <Button
            variant="secondary"
            className="mt-6"
            onClick={() => list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            載入更多成員
          </Button>
        ) : null}
      </div>
      <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="成員分布">
        <div className="relative aspect-[3/4] rounded-md border border-rule bg-surface">
          <LazyTaiwanMap
            members={items.map((m) => m.name)}
            latest={stats.data?.latest.map((m) => m.name) ?? []}
            highlight={highlight}
          />
        </div>
        <p className="zone mt-3 text-xs text-ink-muted">
          每個點代表一位公開展示的成員（以名稱雜湊對應位置，不是真實所在地）。
          {stats.data
            ? ` 目前共 ${stats.data.members} 位成員、${stats.data.subdomains} 個子網域。`
            : ""}
        </p>
      </aside>
    </div>
  );
}
