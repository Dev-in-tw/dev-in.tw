import type { ComponentProps } from "react";
import { cn } from "@/lib/cn.ts";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-rule bg-surface px-1 font-mono text-[0.72rem] leading-none text-ink-muted shadow-[0_1px_0_var(--rule)]",
        className,
      )}
      {...props}
    />
  );
}
