"use client";

import { useQuery } from "@tanstack/react-query";
import { LazyTaiwanMap } from "@/components/map/lazy-map.tsx";
import { q } from "@/lib/queries.ts";

export function HeroMap() {
  const directory = useQuery(q.directory());
  const stats = useQuery(q.stats());
  const members = directory.data?.items.map((m) => m.name) ?? [];
  const latest = stats.data?.latest.map((m) => m.name) ?? [];
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {directory.isSuccess ? <LazyTaiwanMap members={members} latest={latest} /> : null}
    </div>
  );
}
