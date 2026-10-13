"use client";

import { DropdownMenu as M } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn.ts";

export const Dropdown = M.Root;
export const DropdownTrigger = M.Trigger;

export function DropdownContent({ className, ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={6}
        align="end"
        className={cn(
          "enter-pop z-50 min-w-48 rounded-md border border-rule bg-bg p-1 shadow-[4px_4px_0_var(--shadow)]",
          className,
        )}
        {...props}
      />
    </M.Portal>
  );
}

export function DropdownItem({ className, ...props }: ComponentProps<typeof M.Item>) {
  return (
    <M.Item
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-ink-muted",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownLabel({ className, ...props }: ComponentProps<typeof M.Label>) {
  return <M.Label className={cn("px-2.5 py-1.5 text-xs text-ink-muted", className)} {...props} />;
}

export function DropdownSeparator() {
  return <M.Separator className="my-1 h-px bg-rule" />;
}

export const DropdownRadioGroup = M.RadioGroup;

export function DropdownRadioItem({ className, children, ...props }: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-surface-2 [&_svg]:size-4",
        className,
      )}
      {...props}
    >
      <span className="zone w-4 text-magpie" aria-hidden>
        <M.ItemIndicator>●</M.ItemIndicator>
      </span>
      {children}
    </M.RadioItem>
  );
}
