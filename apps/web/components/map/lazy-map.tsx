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

  // 等 load 事件之後再等一次 idle，才建立 WebGL context（shader 編譯會佔用主執行緒）
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 300));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    let id: number | undefined;
    const start = () => {
      id = idle(() => setReady(true), { timeout: 3000 });
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
    return () => {
      window.removeEventListener("load", start);
      if (id !== undefined) cancel(id);
    };
  }, []);

  if (!ready) return null;
  return <TaiwanMap {...props} reducedMotion={reducedMotion} />;
}
