"use client";

import { useQuery } from "@tanstack/react-query";
import { Pause, Play } from "lucide-react";
import { useState } from "react";
import { usePreferences } from "@/lib/preferences.tsx";
import { q } from "@/lib/queries.ts";
import { relativeTime } from "@/lib/time.ts";

/** 「剛剛 · alice.dev-in.tw 加入」跑馬燈：只顯示 opt-in 的成員，hover 時暫停，旁邊有暫停按鈕（WCAG 2.2.2） */
export function Ticker() {
  const { data } = useQuery(q.stats());
  const { prefs, setPref } = usePreferences();
  const [paused, setPaused] = useState(false);
  const items = data?.latest ?? [];
  const stopped = paused || prefs.motionPaused;

  if (items.length === 0) {
    return <div className="h-12 border-b border-rule" aria-hidden />;
  }

  const row = items.map((m) => (
    <li key={m.name} className="zone flex shrink-0 items-center gap-2 px-6 text-sm">
      <span className="text-ink-muted">{relativeTime(m.since)}</span>
      <span aria-hidden className="text-rule">
        ·
      </span>
      <a href={`https://${m.fqdn}`} className="text-ink hover:text-magpie" rel="noreferrer">
        {m.fqdn}
      </a>
      <span className="text-ink-muted">加入</span>
    </li>
  ));

  return (
    <section
      aria-label="最新加入的成員"
      className="marquee relative flex h-12 items-center border-b border-rule bg-surface"
    >
      <div className="min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_6%,#000_94%,transparent)]">
        <div
          className="animate-marquee flex w-max motion-reduce:animate-none"
          style={{
            animationPlayState: stopped ? "paused" : undefined,
            ["--marquee-duration" as string]: `${items.length * 5}s`,
          }}
        >
          <ul className="flex">{row}</ul>
          <ul className="flex" aria-hidden>
            {row}
          </ul>
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          setPaused(!stopped);
          if (prefs.motionPaused) setPref("motionPaused", false);
        }}
        className="mr-2 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
        aria-label={stopped ? "繼續播放跑馬燈" : "暫停跑馬燈"}
        aria-pressed={stopped}
      >
        {stopped ? (
          <Play className="size-4" aria-hidden />
        ) : (
          <Pause className="size-4" aria-hidden />
        )}
      </button>
    </section>
  );
}
