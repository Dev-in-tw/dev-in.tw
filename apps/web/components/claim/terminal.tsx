"use client";

import type { Availability } from "@dit/contract";
import { useQueryClient } from "@tanstack/react-query";
import { CornerDownLeft } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { api } from "@/lib/api/client.ts";
import {
  availabilityReducer,
  initialAvailability,
  isClaimable,
  normalizeInput,
  type Tone,
  toneOf,
} from "@/lib/availability.ts";
import { cn } from "@/lib/cn.ts";
import { errorMessage } from "@/lib/errors.ts";
import { t } from "@/lib/i18n/zh-Hant.ts";
import { useReducedMotion } from "@/lib/use-reduced-motion.ts";
import { Typewriter } from "./typewriter.tsx";

const DEBOUNCE_MS = 300;
const SUFFIX = ".dev-in.tw";

export function availabilityQueryKey(name: string) {
  return ["checkAvailability", { name }] as const;
}

/**
 * 終端機提示列：`$ claim ▌.dev-in.tw`。輸入框嵌在提示列裡，後綴以彈簧曲線貼著文字移動；
 * 停止輸入 300ms 後查詢，結果逐字顯示（§4.4 #1）。可用 Tab 接受灰色的建議補完（像 fish shell）。
 */
export function ClaimTerminal({
  initialName = "",
  onSubmit,
  autoFocus,
  size = "lg",
  onResult,
}: {
  initialName?: string;
  onSubmit: (name: string) => void;
  autoFocus?: boolean;
  size?: "lg" | "md";
  onResult?: (result: Availability | null) => void;
}) {
  const [state, dispatch] = useReducer(availabilityReducer, initialAvailability, (s) =>
    initialName ? availabilityReducer(s, { type: "input", value: initialName }) : s,
  );
  const [value, setValue] = useState(initialName);
  const queryClient = useQueryClient();
  const reduced = useReducedMotion();
  const inputId = useId();
  const hintId = useId();
  const mirror = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  // 停止輸入 300ms 後查詢；同一個名字的結果由 TanStack Query 快取
  useEffect(() => {
    if (state.phase !== "typing") return;
    const { seq, name } = state;
    const timer = setTimeout(async () => {
      dispatch({ type: "check", seq });
      try {
        const result = await queryClient.fetchQuery({
          queryKey: availabilityQueryKey(name),
          queryFn: ({ signal }) => api("checkAvailability", { params: { name }, signal }),
          staleTime: 10_000,
        });
        dispatch({ type: "result", seq, result });
      } catch (error) {
        dispatch({ type: "error", seq, message: errorMessage(error) });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [state, queryClient]);

  const result = state.phase === "result" ? state.result : null;
  useEffect(() => {
    onResult?.(result);
  }, [result, onResult]);

  const ghostFull = result?.suggestions.find((s) => s.startsWith(state.name) && s !== state.name);
  const ghost = ghostFull && value === state.name ? ghostFull.slice(state.name.length) : "";
  const completion = result && !isClaimable(result.status) ? result.suggestions[0] : undefined;

  // 量測文字寬度，讓輸入框與後綴跟著文字伸縮
  useLayoutEffect(() => {
    if (!mirror.current) return;
    const el = mirror.current;
    const measure = () => setWidth(Math.ceil(el.getBoundingClientRect().width) + 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const change = (next: string) => {
    setValue(next);
    dispatch({ type: "input", value: next });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const name = normalizeInput(value);
      if (name) onSubmit(name);
      return;
    }
    const atEnd = e.currentTarget.selectionStart === value.length;
    if ((e.key === "Tab" && !e.shiftKey) || (e.key === "ArrowRight" && atEnd)) {
      const accept = ghostFull ?? (e.key === "Tab" ? completion : undefined);
      if (accept && accept !== value) {
        e.preventDefault();
        change(accept);
      }
    }
  };

  const tone: Tone =
    state.phase === "result"
      ? toneOf(state.result.status)
      : state.phase === "error"
        ? "no"
        : "idle";
  const checking = state.phase === "checking" || state.phase === "typing";
  const big = size === "lg";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius-dialog)] border border-rule bg-bg text-left shadow-[6px_6px_0_var(--shadow)]",
        "dark:bg-[oklch(0.13_0.015_262)]",
      )}
    >
      <div
        className="flex items-center gap-2 border-b border-rule bg-surface px-4 py-2"
        aria-hidden
      >
        <span className="size-2.5 rounded-full bg-beak" />
        <span className="size-2.5 rounded-full bg-amber" />
        <span className="size-2.5 rounded-full bg-signal" />
        <span className="zone ml-2 text-xs text-ink-muted">zsh — claim</span>
      </div>

      <div className={cn("px-4 sm:px-5", big ? "py-5 sm:py-6" : "py-4")}>
        <label htmlFor={inputId} className="sr-only">
          想要的子網域名稱
        </label>
        <div
          className={cn(
            "zone flex flex-wrap items-baseline gap-x-2 gap-y-1",
            big ? "text-step-2" : "text-step-1",
          )}
        >
          <StatusDot tone={tone} checking={checking && Boolean(value)} />
          <span className="text-magpie select-none" aria-hidden>
            $
          </span>
          <span className="text-ink-muted select-none" aria-hidden>
            claim
          </span>
          <span className="relative inline-flex min-w-0 items-baseline">
            {/* 量測用的鏡像：決定輸入框寬度，並顯示灰色的建議補完 */}
            <span
              ref={mirror}
              aria-hidden
              className="pointer-events-none invisible absolute whitespace-pre"
            >
              {value || "你的名字"}
            </span>
            <input
              id={inputId}
              data-search
              value={value}
              onChange={(e) => change(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="你的名字"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              maxLength={63}
              // biome-ignore lint/a11y/noAutofocus: 首頁與申請頁的主要動作就是輸入名字
              autoFocus={autoFocus}
              aria-describedby={hintId}
              className="min-w-[2ch] max-w-[60vw] border-0 bg-transparent p-0 text-ink caret-beak outline-none placeholder:text-ink-muted/70 focus-visible:outline-none sm:max-w-[22ch]"
              style={{
                width: width ? `${width}px` : undefined,
                transition: reduced ? undefined : "width 260ms cubic-bezier(.34,1.56,.64,1)",
              }}
            />
            {ghost ? (
              <span aria-hidden className="pointer-events-none whitespace-pre text-ink-muted/60">
                {ghost}
              </span>
            ) : null}
            <span className="whitespace-pre text-ink-muted" aria-hidden>
              {SUFFIX}
            </span>
          </span>
          <button
            type="button"
            onClick={() => {
              const name = normalizeInput(value);
              if (name) onSubmit(name);
            }}
            disabled={!value}
            className="ml-auto inline-flex h-9 items-center gap-1.5 self-center rounded-md bg-primary px-3 font-sans text-sm font-medium text-primary-fg transition-[box-shadow,opacity] hover:shadow-[inset_0_-3px_0_var(--beak)] disabled:opacity-40"
          >
            申請
            <CornerDownLeft className="size-3.5" aria-hidden />
          </button>
        </div>

        <ResultLine state={state} reduced={reduced} />

        {completion || ghostFull ? (
          <p className="zone mt-2 text-sm text-ink-muted">
            <span aria-hidden>↳ </span>
            試試{" "}
            {(result?.suggestions ?? []).map((s, i) => (
              <span key={s}>
                {i > 0 ? "、" : ""}
                <button
                  type="button"
                  className="text-magpie underline decoration-dotted underline-offset-4 hover:decoration-beak"
                  onClick={() => change(s)}
                >
                  {s}
                </button>
              </span>
            ))}
          </p>
        ) : null}

        <p id={hintId} className="sr-only">
          輸入後會自動查詢是否可以申請，按 Enter 前往申請。
          {ghostFull || completion ? `按 Tab 補完為 ${ghostFull ?? completion}。` : ""}
        </p>
      </div>
    </div>
  );
}

function StatusDot({ tone, checking }: { tone: Tone; checking: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-block size-3 shrink-0 self-center rounded-full border-2 transition-all duration-300 ease-out",
        checking && "animate-pulse border-amber bg-amber/30",
        !checking && tone === "idle" && "border-field bg-transparent",
        !checking && tone === "ok" && "scale-110 border-signal bg-signal",
        !checking && tone === "warn" && "border-amber bg-amber",
        !checking && tone === "no" && "rounded-[3px] border-danger bg-danger",
      )}
    />
  );
}

function ResultLine({
  state,
  reduced,
}: {
  state: ReturnType<typeof availabilityReducer>;
  reduced: boolean;
}) {
  let visual: ReactNode = <span className="text-ink-muted">;; 輸入名字，馬上幫你查 NXDOMAIN</span>;
  let spoken = "";

  if (state.phase === "typing" || state.phase === "checking") {
    visual = (
      <span className="text-ink-muted">
        ;; resolving {state.name}
        {SUFFIX}{" "}
        <span className="inline-flex gap-0.5">
          {[0, 1, 2].map((i) => (
            <span key={i} className="resolver-dot" style={{ animationDelay: `${i * 120}ms` }}>
              ·
            </span>
          ))}
        </span>
      </span>
    );
  } else if (state.phase === "error") {
    visual = <span className="text-danger">;; ERROR {state.message}</span>;
    spoken = state.message;
  } else if (state.phase === "result") {
    const r = state.result;
    const copy = t.availability[r.status];
    const tone = toneOf(r.status);
    const text = `${copy.code} → ${copy.text}${tone === "ok" ? " ✓" : ""}`;
    spoken = `${r.fqdn}：${copy.text}${r.reason ? `。${r.reason}` : ""}`;
    visual = (
      <span>
        <span
          className={cn(
            tone === "ok" && "text-signal",
            tone === "warn" && "text-amber",
            tone === "no" && "text-danger",
          )}
        >
          ;; <Typewriter text={text} reduced={reduced} />
        </span>
        {r.reason ? <span className="mt-1 block text-ink-muted">;; {r.reason}</span> : null}
        {r.status === "review" && r.reviewReasons?.length ? (
          <span className="mt-1 block text-ink-muted">
            ;; 原因：{r.reviewReasons.map(t.reviewReason).join("、")}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <div className="zone mt-3 min-h-[1.6em] text-sm sm:text-[0.95rem]">
      <div aria-hidden>{visual}</div>
      <p className="sr-only" aria-live="polite" data-testid="availability-live">
        {spoken}
      </p>
    </div>
  );
}
