"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { THEME_STORAGE_KEY } from "./theme-script.ts";

export type ThemeChoice = "system" | "light" | "dark";

interface ThemeContextValue {
  theme: ThemeChoice;
  resolved: "light" | "dark";
  /** origin：按鈕中心點，用來決定圓形擴散的起點（§4.4 #11） */
  setTheme: (next: ThemeChoice, origin?: { x: number; y: number }) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function subscribeSystem(callback: () => void) {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

function apply(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setChoice] = useState<ThemeChoice>("system");
  // 首次 render 時還不知道儲存的偏好（SSR 沒有 localStorage），inline script 已經套好 class，
  // 在讀到偏好之前不要動它，否則會閃一下
  const [ready, setReady] = useState(false);
  const systemDark = useSyncExternalStore(
    subscribeSystem,
    () => matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );

  useEffect(() => {
    setChoice(readStored());
    setReady(true);
  }, []);

  const resolved: "light" | "dark" = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    if (ready) apply(resolved === "dark");
  }, [ready, resolved]);

  const setTheme = useCallback((next: ThemeChoice, origin?: { x: number; y: number }) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // 無痕模式等情況存不了，只影響這次瀏覽
    }
    const nextDark =
      next === "dark" || (next === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const root = document.documentElement;
    if (!document.startViewTransition || reduce || nextDark === root.classList.contains("dark")) {
      setChoice(next);
      apply(nextDark);
      return;
    }
    if (origin) {
      root.style.setProperty("--vt-x", `${origin.x}px`);
      root.style.setProperty("--vt-y", `${origin.y}px`);
    }
    root.dataset.themeSwitching = "";
    const transition = document.startViewTransition(() => {
      flushSync(() => setChoice(next));
      apply(nextDark);
    });
    transition.finished.finally(() => {
      delete root.dataset.themeSwitching;
    });
  }, []);

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
