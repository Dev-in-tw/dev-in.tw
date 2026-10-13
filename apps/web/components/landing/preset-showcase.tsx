"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn.ts";

const PRESETS = [
  {
    id: "github-pages",
    title: "GitHub Pages",
    hint: "填 GitHub 帳號",
    lines: [
      ["@", "CNAME", "you.github.io."],
      ["_github-pages-challenge-you", "TXT", '"a1b2c3…"'],
    ],
  },
  {
    id: "vercel",
    title: "Vercel",
    hint: "不用填，直接套用",
    lines: [["@", "CNAME", "cname.vercel-dns.com."]],
  },
  {
    id: "netlify",
    title: "Netlify",
    hint: "填網站名稱",
    lines: [["@", "CNAME", "my-site.netlify.app."]],
  },
  {
    id: "cloudflare-pages",
    title: "Cloudflare Pages",
    hint: "填專案名稱",
    lines: [["@", "CNAME", "my-project.pages.dev."]],
  },
] as const;

/** 一鍵設定：點卡片展開，預覽會產生的紀錄（git diff 風格） */
export function PresetShowcase() {
  const [open, setOpen] = useState<string | null>("github-pages");
  return (
    <section aria-labelledby="presets-title" className="border-y border-rule bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <p className="zone text-sm text-ink-muted">
          <span className="text-beak">;</span> presets
        </p>
        <h2 id="presets-title" className="mt-2 text-step-4 font-semibold tracking-tight">
          常用平台，一鍵設定
        </h2>
        <p className="mt-3 max-w-2xl text-ink-muted">
          套用前會先列出要新增與刪除的紀錄，確認後才一次送出。不用背 CNAME 該填什麼。
        </p>
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {PRESETS.map((preset) => {
            const expanded = open === preset.id;
            return (
              <div
                key={preset.id}
                className={cn(
                  "rounded-md border bg-bg transition-[box-shadow,border-color] duration-200",
                  expanded
                    ? "border-magpie shadow-[4px_4px_0_var(--magpie)]"
                    : "border-rule shadow-[4px_4px_0_var(--shadow)]",
                )}
              >
                <h3>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`preset-${preset.id}`}
                    onClick={() => setOpen(expanded ? null : preset.id)}
                    className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
                  >
                    <span>
                      <span className="block text-step-1 font-semibold">{preset.title}</span>
                      <span className="text-sm text-ink-muted">{preset.hint}</span>
                    </span>
                    <ChevronDown
                      className={cn(
                        "size-5 text-ink-muted transition-transform duration-300",
                        expanded && "rotate-180",
                      )}
                      aria-hidden
                    />
                  </button>
                </h3>
                {expanded ? (
                  <div id={`preset-${preset.id}`}>
                    <div className="zone border-t border-rule px-5 py-4 text-sm">
                      {preset.lines.map(([name, type, value], i) => (
                        <p
                          key={name + type}
                          className="diff-line flex gap-3 whitespace-nowrap"
                          style={{ animationDelay: `${i * 30}ms` }}
                        >
                          <span className="text-signal" aria-hidden>
                            +
                          </span>
                          <span className="sr-only">新增</span>
                          <span className="min-w-0 truncate">{name}</span>
                          <span className="text-beak">{type}</span>
                          <span className="min-w-0 truncate text-magpie">{value}</span>
                        </p>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
