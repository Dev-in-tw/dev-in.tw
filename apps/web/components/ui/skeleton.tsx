import type { ComponentProps } from "react";
import { cn } from "@/lib/cn.ts";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none", className)}
      {...props}
    />
  );
}
