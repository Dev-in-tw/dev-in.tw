"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useRef } from "react";
import {
  Dropdown,
  DropdownContent,
  DropdownLabel,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownTrigger,
} from "@/components/ui/dropdown.tsx";
import { cn } from "@/lib/cn.ts";
import { type ThemeChoice, useTheme } from "@/lib/theme.tsx";

const LABEL: Record<ThemeChoice, string> = {
  system: "跟隨系統",
  light: "淺色（紙）",
  dark: "深色（夜）",
};

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, resolved, setTheme } = useTheme();
  const trigger = useRef<HTMLButtonElement>(null);
  const Icon = theme === "system" ? Monitor : resolved === "dark" ? Moon : Sun;

  const choose = (value: string) => {
    const rect = trigger.current?.getBoundingClientRect();
    setTheme(
      value as ThemeChoice,
      rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined,
    );
  };

  return (
    <Dropdown>
      <DropdownTrigger
        ref={trigger}
        className={cn(
          "inline-flex size-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink",
          className,
        )}
        aria-label={`主題：${LABEL[theme]}`}
      >
        <Icon className="size-[1.1rem]" aria-hidden />
      </DropdownTrigger>
      <DropdownContent>
        <DropdownLabel>主題</DropdownLabel>
        <DropdownRadioGroup value={theme} onValueChange={choose}>
          {(Object.keys(LABEL) as ThemeChoice[]).map((value) => (
            <DropdownRadioItem key={value} value={value}>
              {LABEL[value]}
            </DropdownRadioItem>
          ))}
        </DropdownRadioGroup>
      </DropdownContent>
    </Dropdown>
  );
}
