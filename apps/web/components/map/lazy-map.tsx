"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useReducedMotion } from "@/lib/use-reduced-motion.ts";

const TaiwanMap = dynamic(() => import("./taiwan-map.tsx").then((m) => m.TaiwanMap), {
  ssr: false,
});

/** 等瀏覽器閒下來才載入地圖（不影響 LCP 與 INP） */
export function LazyTaiwanMap(props: {
  members?: string[];
  latest?: string[];
  highlight?: string | null;
  className?: string;
}) {
  const [ready, setReady] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 200));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const id = idle(() => setReady(true), { timeout: 1500 });
    return () => cancel(id);
  }, []);

  if (!ready) return null;
  return <TaiwanMap {...props} reducedMotion={reducedMotion} />;
}
