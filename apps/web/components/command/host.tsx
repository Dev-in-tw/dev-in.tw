"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { usePreferences } from "@/lib/preferences.tsx";
import { OPEN_EVENT } from "./events.ts";

// cmdk 與指令解析只在第一次開啟時才下載，不進首屏 bundle
const CommandPalette = dynamic(() => import("./palette.tsx").then((m) => m.CommandPalette), {
  ssr: false,
});

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function CommandPaletteHost() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [initial, setInitial] = useState("");
  const { prefs } = usePreferences();

  useEffect(() => {
    const onOpen = (e: Event) => {
      setInitial((e as CustomEvent<string>).detail ?? "");
      setLoaded(true);
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        // ⌘K 是開關面板的主要入口；設定裡可關閉全域快捷鍵（WCAG 2.1.4）
        if (!prefs.shortcuts) return;
        e.preventDefault();
        setInitial("");
        setLoaded(true);
        setOpen((v) => !v);
        return;
      }
      if (!prefs.shortcuts || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        const search = document.querySelector<HTMLElement>("[data-search]");
        if (search) {
          e.preventDefault();
          search.focus();
        }
      } else if (e.key === "?") {
        e.preventDefault();
        setInitial("help");
        setLoaded(true);
        setOpen(true);
      }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, [prefs.shortcuts]);

  if (!loaded) return null;
  return <CommandPalette open={open} onOpenChange={setOpen} initial={initial} />;
}
