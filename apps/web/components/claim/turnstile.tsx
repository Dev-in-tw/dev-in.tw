"use client";

import { Check } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn.ts";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      remove: (id: string) => void;
      reset: (id: string) => void;
    };
  }
}

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("turnstile"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Cloudflare Turnstile。site key 由 GET /meta 下發（前端不使用 NEXT_PUBLIC_*）。
 * mock server 會給 `mock-` 開頭的 key：這時顯示本機用的假驗證框，e2e 不必連外網。
 * Token 只是證明人機驗證通過，真正的驗證永遠在後端（siteverify）。
 */
export function Turnstile({
  siteKey,
  onToken,
  resetSignal = 0,
}: {
  siteKey: string | undefined;
  onToken: (token: string | null) => void;
  resetSignal?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [mockChecked, setMockChecked] = useState(false);
  const id = useId();
  const isMock = siteKey?.startsWith("mock-") ?? false;

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetSignal 只用來觸發重新驗證
  useEffect(() => {
    setMockChecked(false);
    onToken(null);
    if (!siteKey || isMock || !ref.current) return;
    let widget: string | undefined;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !ref.current || !window.turnstile) return;
        widget = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          language: "zh-tw",
          theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
          callback: (token: string) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => setFailed(true),
        });
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      if (widget) window.turnstile?.remove(widget);
    };
  }, [siteKey, isMock, resetSignal]);

  if (isMock) {
    return (
      <label
        htmlFor={id}
        className={cn(
          "flex w-fit cursor-pointer items-center gap-3 rounded-md border px-4 py-3 text-sm transition-colors",
          mockChecked ? "border-signal bg-signal-soft" : "border-field bg-surface",
        )}
      >
        <input
          id={id}
          type="checkbox"
          className="peer sr-only"
          checked={mockChecked}
          onChange={(e) => {
            setMockChecked(e.target.checked);
            onToken(e.target.checked ? "XXXX.DUMMY.TOKEN.XXXX" : null);
          }}
        />
        <span
          aria-hidden
          className="inline-flex size-6 items-center justify-center rounded border border-field bg-bg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-magpie"
        >
          {mockChecked ? <Check className="size-4 text-signal" /> : null}
        </span>
        <span>
          我是人類
          <span className="zone ml-2 text-xs text-ink-muted">turnstile (mock)</span>
        </span>
      </label>
    );
  }

  return (
    <div>
      <div ref={ref} className="min-h-[65px]" />
      {failed ? (
        <p role="alert" className="text-sm text-danger">
          人機驗證載入失敗，請關掉擋廣告的擴充功能或重新整理頁面。
        </p>
      ) : null}
    </div>
  );
}
