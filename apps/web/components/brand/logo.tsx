import { cn } from "@/lib/cn.ts";

/**
 * 「D.」標誌：保留舊 logo 的粗體 D 與句點，D 是鵲藍的身體，句點是鵲喙紅。
 * D 的右緣是一段完整半圓，左上角留一道終端機游標寬的缺口，暗示 zone file 的行首。
 */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <path d="M4 4h11a12 12 0 0 1 0 24H4zM8 10v12h3V10z" fill="var(--magpie)" fillRule="evenodd" />
      <circle cx="27.5" cy="25" r="3.5" fill="var(--beak)" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("zone font-semibold tracking-tight", className)}>
      dev-in<span className="text-beak">.</span>tw
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className="size-7" />
      <Wordmark className="text-[1.05rem]" />
    </span>
  );
}
