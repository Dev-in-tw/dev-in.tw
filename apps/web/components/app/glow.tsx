"use client";

import type { ComponentProps, PointerEvent } from "react";

/** 游標光暈（§4.4 #13）：pointermove 時更新 --x、--y；樣式只在 (hover:hover) and (pointer:fine) 生效 */
export function GlowCard({ onPointerMove, ...props }: ComponentProps<"div">) {
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--x", `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty("--y", `${e.clientY - rect.top}px`);
    onPointerMove?.(e);
  };
  return <div data-glow onPointerMove={move} {...props} />;
}
