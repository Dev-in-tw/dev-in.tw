"use client";

import { useState } from "react";
import { cn } from "@/lib/cn.ts";

/** GitHub 頭像；載入失敗時退回首字母 */
export function Avatar({
  src,
  login,
  size = 32,
  className,
}: {
  src: string;
  login: string;
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span
        aria-hidden
        className={cn(
          "zone inline-flex shrink-0 items-center justify-center rounded-full bg-magpie-soft font-semibold text-magpie",
          className,
        )}
        style={{ width: size, height: size, fontSize: size * 0.45 }}
      >
        {login.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    // biome-ignore lint/performance/noImgElement: GitHub 頭像是外部小圖，不經過 Next 的影像最佳化
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
      className={cn("shrink-0 rounded-full border border-rule bg-surface-2", className)}
    />
  );
}
