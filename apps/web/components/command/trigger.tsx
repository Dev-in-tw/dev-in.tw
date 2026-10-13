"use client";

import { Search } from "lucide-react";
import { Kbd } from "@/components/ui/kbd.tsx";
import { cn } from "@/lib/cn.ts";
import { openCommandPalette } from "./events.ts";

export function CommandTrigger({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openCommandPalette()}
      className={cn(
        "group inline-flex h-9 items-center gap-2 rounded-md border border-rule bg-surface px-2.5 text-sm text-ink-muted transition-colors hover:border-field hover:text-ink",
        className,
      )}
      aria-label="開啟指令面板"
      aria-keyshortcuts="Meta+K Control+K"
    >
      <Search className="size-4" aria-hidden />
      <span className="zone hidden text-[0.8rem] lg:inline">
        <span className="text-magpie">$</span> 輸入指令
      </span>
      <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
    </button>
  );
}
