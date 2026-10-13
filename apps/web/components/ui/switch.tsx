"use client";

import { Switch as RSwitch } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn.ts";

export function Switch({ className, ...props }: ComponentProps<typeof RSwitch.Root>) {
  return (
    <RSwitch.Root
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-field bg-surface-2 transition-colors data-[state=checked]:border-magpie data-[state=checked]:bg-magpie disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RSwitch.Thumb className="block size-4 translate-x-1 rounded-full bg-ink-muted shadow transition-transform duration-200 ease-out data-[state=checked]:translate-x-6 data-[state=checked]:bg-primary-fg" />
    </RSwitch.Root>
  );
}
