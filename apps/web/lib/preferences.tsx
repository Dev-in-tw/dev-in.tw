"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

/**
 * 使用者偏好（只存在這台裝置的 localStorage，不含任何憑證）：
 * - shortcuts：全域快捷鍵（WCAG 2.1.4：要能關閉）
 * - motion：循環動畫暫停（WCAG 2.2.2）
 */
export interface Preferences {
  shortcuts: boolean;
  motionPaused: boolean;
}

const KEY = "dit-prefs";
const DEFAULTS: Preferences = { shortcuts: true, motionPaused: false };

interface Ctx {
  prefs: Preferences;
  setPref: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
}

const PreferencesContext = createContext<Ctx>({ prefs: DEFAULTS, setPref: () => {} });

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setPrefs({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<Preferences>) });
    } catch {
      // 忽略壞掉的偏好設定
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.motion = prefs.motionPaused ? "paused" : "running";
  }, [prefs.motionPaused]);

  const setPref = useCallback(<K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // 存不了就只影響這次瀏覽
      }
      return next;
    });
  }, []);

  return <PreferencesContext value={{ prefs, setPref }}>{children}</PreferencesContext>;
}

export function usePreferences(): Ctx {
  return useContext(PreferencesContext);
}
