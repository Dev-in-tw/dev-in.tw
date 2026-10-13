"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn.ts";
import { type ThemeChoice, useTheme } from "@/lib/theme.tsx";

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<ThemeChoice, string> = { system: "跟隨系統", light: "淺色", dark: "深色" };

/** 行銷頁用的輕量主題切換：按一下輪替 系統 → 淺 → 深（不載入下拉選單元件） */
export function ThemeCycle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const Icon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  return (
    <button
      type="button"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setTheme(NEXT[theme], { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink",
        className,
      )}
      aria-label={`主題：${LABEL[theme]}（按一下切換成${LABEL[NEXT[theme]]}）`}
      title={`主題：${LABEL[theme]}`}
    >
      <Icon className="size-[1.1rem]" aria-hidden />
    </button>
  );
}
