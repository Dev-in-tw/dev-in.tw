"use client";

import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { LazyTaiwanMap } from "@/components/map/lazy-map.tsx";
import { q } from "@/lib/queries.ts";

const WIDE = "(min-width: 1024px)";
const subscribe = (cb: () => void) => {
  const mq = matchMedia(WIDE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** 地圖只在桌面寬度顯示；窄螢幕連載入都不做，避免在手機上白白建立 WebGL context */
export function HeroMap() {
  const wide = useSyncExternalStore(
    subscribe,
    () => matchMedia(WIDE).matches,
    () => false,
  );
  return wide ? <HeroMapInner /> : null;
}

function HeroMapInner() {
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
