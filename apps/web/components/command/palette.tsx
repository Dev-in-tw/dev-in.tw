"use client";

import type { Subdomain } from "@dit/contract";
import { useQueryClient } from "@tanstack/react-query";
import { Command } from "cmdk";
import {
  ArrowRight,
  BookOpen,
  CornerDownLeft,
  Gauge,
  Globe,
  LayoutGrid,
  Settings,
  Shield,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Dialog as D } from "radix-ui";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "@/components/ui/kbd.tsx";
import { api, isApiError } from "@/lib/api/client.ts";
import { cn } from "@/lib/cn.ts";
import {
  addHref,
  COMMANDS,
  MAGPIE_ASCII,
  parseCommand,
  SYSTEM_RECORDS,
  type Token,
  tokenize,
} from "@/lib/command.ts";
import { errorMessage } from "@/lib/errors.ts";
import { t } from "@/lib/i18n/zh-Hant.ts";
import { useTheme } from "@/lib/theme.tsx";

const HISTORY_KEY = "dit-cmd-history";

const ROLE_CLASS: Record<Token["role"], string> = {
  command: "text-magpie font-semibold",
  type: "text-beak font-semibold",
  name: "text-ink",
  value: "text-signal",
  ttl: "text-amber",
  arg: "text-amber",
  error: "text-danger underline decoration-wavy decoration-1 underline-offset-4",
  space: "",
};

const NAV = [
  { label: "控制台", href: "/dashboard", icon: LayoutGrid, keywords: "dashboard 總覽" },
  { label: "使用文件", href: "/docs", icon: BookOpen, keywords: "docs help" },
  { label: "成員展示", href: "/explore", icon: Globe, keywords: "explore members" },
  { label: "服務狀態", href: "/status", icon: Gauge, keywords: "status uptime" },
  { label: "設定", href: "/settings", icon: Settings, keywords: "settings sessions" },
  { label: "管理後台", href: "/admin", icon: Shield, keywords: "admin" },
];

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

/**
 * ⌘K 指令面板（§4.4 #9）：終端機外觀，輸入時即時語法上色（type、name、value 分色），
 * ↑／↓ 叫出歷史（localStorage，只存指令文字）。`dig dev-in.tw` 有彩蛋（§4.4 #14）。
 */
export function CommandPalette({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { setTheme } = useTheme();
  const [input, setInput] = useState(initial);
  const [output, setOutput] = useState<ReactNode>(null);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setInput(initial === "help" ? "" : initial);
      setOutput(initial === "help" ? <Help /> : null);
      setHistoryIndex(-1);
    }
  }, [open, initial]);

  const parsed = useMemo(() => parseCommand(input), [input]);
  const tokens = useMemo(() => tokenize(input), [input]);
  const currentSub = pathname.match(/^\/dashboard\/(?!transfers)([^/]+)/)?.[1];

  const remember = (text: string) => {
    try {
      const next = [text, ...loadHistory().filter((h) => h !== text)].slice(0, 20);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {}
  };

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  const firstSubdomain = async (): Promise<string | null> => {
    if (currentSub) return currentSub;
    try {
      const cached = queryClient.getQueryData<{ items: Subdomain[] }>([
        "listSubdomains",
        null,
        null,
      ]);
      const list = cached ?? (await api("listSubdomains"));
      return list.items.find((s) => s.status === "active")?.name ?? list.items[0]?.name ?? null;
    } catch {
      return null;
    }
  };

  const run = async () => {
    const text = input.trim();
    if (!text) return;
    remember(text);
    setHistoryIndex(-1);
    switch (parsed.kind) {
      case "claim":
        return go(`/claim/${encodeURIComponent(parsed.name)}`);
      case "go":
        return go(`/dashboard/${encodeURIComponent(parsed.name)}`);
      case "add": {
        const sub = await firstSubdomain();
        if (!sub) {
          setOutput(
            <Line tone="danger">;; 你還沒有子網域。先用 claim &lt;name&gt; 申請一個吧</Line>,
          );
          return;
        }
        return go(addHref(sub, parsed));
      }
      case "theme":
        setTheme(parsed.theme);
        setOutput(<Line tone="signal">;; theme → {parsed.theme}</Line>);
        return;
      case "logout":
        try {
          await api("logout");
        } catch {}
        onOpenChange(false);
        router.push("/");
        router.refresh();
        return;
      case "help":
        setOutput(<Help />);
        return;
      case "dig":
        setOutput(<Line>;; resolving {parsed.name}.dev-in.tw …</Line>);
        setOutput(await dig(parsed.name));
        return;
      case "incomplete":
        setOutput(<Line tone="amber">;; 用法：{parsed.usage}</Line>);
        return;
      case "unknown":
        setOutput(
          <Line tone="danger">
            ;; command not found: {text.split(/\s+/)[0]}。輸入 help 看看有哪些指令
          </Line>,
        );
        return;
      case "empty":
        return;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp" && (input === "" || historyIndex >= 0)) {
      const history = loadHistory();
      if (history.length === 0) return;
      e.preventDefault();
      const next = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(next);
      setInput(history[next] ?? "");
    } else if (e.key === "ArrowDown" && historyIndex >= 0) {
      e.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setInput(next < 0 ? "" : (loadHistory()[next] ?? ""));
    }
  };

  const isCommand = !["empty", "unknown"].includes(parsed.kind) || /^\S+\s/.test(input);
  const showNav = parsed.kind === "empty" || parsed.kind === "unknown";
  const matchesNav = (item: (typeof NAV)[number]) =>
    !input.trim() ||
    `${item.label} ${item.keywords} ${item.href}`
      .toLowerCase()
      .includes(input.trim().toLowerCase());

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="enter-fade fixed inset-0 z-[60] bg-[color-mix(in_srgb,var(--ink)_40%,transparent)] backdrop-blur-[2px]" />
        <D.Content
          aria-describedby={undefined}
          className="enter-pop fixed top-[12vh] left-1/2 z-[60] w-[min(94vw,40rem)] -translate-x-1/2 overflow-hidden rounded-[var(--radius-dialog)] border border-rule bg-bg shadow-[8px_8px_0_var(--shadow)] dark:bg-[oklch(0.13_0.015_262)]"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <D.Title className="sr-only">指令面板</D.Title>
          <Command shouldFilter={false} loop label="指令面板" className="zone">
            <div className="flex items-center gap-2 border-b border-rule px-4 py-3.5">
              <span className="text-magpie select-none" aria-hidden>
                $
              </span>
              <div className="relative min-w-0 flex-1">
                {/* 語法上色：和輸入框重疊、字距完全相同的鏡像層 */}
                <div
                  ref={overlayRef}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre text-[0.95rem]"
                >
                  {tokens.map((tok, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: token 依位置排列
                    <span key={i} className={ROLE_CLASS[tok.role]}>
                      {tok.text}
                    </span>
                  ))}
                </div>
                <Command.Input
                  ref={inputRef}
                  value={input}
                  onValueChange={(v) => {
                    setInput(v);
                    setHistoryIndex(-1);
                  }}
                  onKeyDown={(e) => {
                    onKeyDown(e);
                    if (e.key === "Enter" && isCommand) {
                      e.preventDefault();
                      run();
                    }
                  }}
                  onScroll={(e) => {
                    if (overlayRef.current)
                      overlayRef.current.scrollLeft = e.currentTarget.scrollLeft;
                  }}
                  placeholder="claim、add cname www you.github.io、dig、theme…"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="w-full bg-transparent text-[0.95rem] text-transparent caret-beak outline-none placeholder:text-ink-muted"
                />
              </div>
              <Kbd>esc</Kbd>
            </div>

            <Command.List className="max-h-[min(60vh,26rem)] overflow-y-auto p-2">
              {output ? (
                <div className="px-2 pt-1 pb-3 text-[0.82rem]" aria-live="polite">
                  {output}
                </div>
              ) : null}

              {isCommand && parsed.kind !== "unknown" ? (
                <Command.Item
                  value="run"
                  onSelect={run}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-sm data-[selected=true]:bg-magpie-soft"
                >
                  <CornerDownLeft className="size-4 text-magpie" aria-hidden />
                  <span>{describe(parsed, currentSub)}</span>
                </Command.Item>
              ) : null}

              <Command.Group
                heading="指令"
                className="text-ink-muted [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs"
              >
                {COMMANDS.filter(
                  (c) =>
                    !input.trim() ||
                    c.name.startsWith(input.trim().split(/\s+/)[0]?.toLowerCase() ?? ""),
                ).map((c) => (
                  <Command.Item
                    key={c.name}
                    value={`cmd-${c.name}`}
                    onSelect={() => {
                      setInput(
                        c.usage.includes("<") || c.usage.includes("|") ? `${c.name} ` : c.name,
                      );
                      inputRef.current?.focus();
                    }}
                    className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm text-ink data-[selected=true]:bg-surface-2"
                  >
                    <span className="w-56 shrink-0 text-magpie">{c.usage}</span>
                    <span className="truncate font-sans text-ink-muted">{c.description}</span>
                  </Command.Item>
                ))}
              </Command.Group>

              {showNav ? (
                <Command.Group
                  heading="前往"
                  className="text-ink-muted [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs"
                >
                  {NAV.filter(matchesNav).map((item) => (
                    <Command.Item
                      key={item.href}
                      value={`nav-${item.href}`}
                      onSelect={() => go(item.href)}
                      className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 font-sans text-sm text-ink data-[selected=true]:bg-surface-2"
                    >
                      <item.icon className="size-4 text-ink-muted" aria-hidden />
                      {item.label}
                      <ArrowRight className="ml-auto size-3.5 text-ink-muted" aria-hidden />
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
            </Command.List>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-rule bg-surface px-4 py-2 text-[0.72rem] text-ink-muted">
              <span>
                <Kbd>↵</Kbd> 執行
              </span>
              <span>
                <Kbd>↑</Kbd> 歷史
              </span>
              <span>
                <Kbd>?</Kbd> 說明
              </span>
              <span className="ml-auto">試試 dig dev-in.tw</span>
            </div>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function describe(cmd: ReturnType<typeof parseCommand>, currentSub: string | undefined): string {
  switch (cmd.kind) {
    case "claim":
      return `查詢並申請 ${cmd.name}.dev-in.tw`;
    case "go":
      return `前往 ${cmd.name}.dev-in.tw`;
    case "add":
      return `新增 ${cmd.type} 紀錄 ${cmd.name} → ${cmd.value}${currentSub ? `（在 ${currentSub}.dev-in.tw）` : ""}`;
    case "dig":
      return `dig ${cmd.name}.dev-in.tw`;
    case "theme":
      return `切換成${cmd.theme === "light" ? "淺色" : cmd.theme === "dark" ? "深色" : "跟隨系統"}`;
    case "logout":
      return "登出";
    case "help":
      return "顯示說明";
    case "incomplete":
      return `用法：${cmd.usage}`;
    default:
      return "執行";
  }
}

function Line({ children, tone }: { children: ReactNode; tone?: "danger" | "signal" | "amber" }) {
  return (
    <p
      className={cn(
        "whitespace-pre-wrap",
        tone === "danger" && "text-danger",
        tone === "signal" && "text-signal",
        tone === "amber" && "text-amber",
        !tone && "text-ink-muted",
      )}
    >
      {children}
    </p>
  );
}

function Help() {
  return (
    <div className="space-y-2 text-ink-muted">
      <p>;; 指令</p>
      {COMMANDS.map((c) => (
        <p key={c.name}>
          <span className="inline-block w-64 text-magpie">{c.usage}</span>
          <span className="font-sans">{c.description}</span>
        </p>
      ))}
      <p className="pt-2">;; 快捷鍵（可在「設定」關閉）</p>
      <p>
        <span className="inline-block w-64 text-ink">⌘K / Ctrl+K</span>
        <span className="font-sans">開關指令面板</span>
      </p>
      <p>
        <span className="inline-block w-64 text-ink">/</span>
        <span className="font-sans">聚焦頁面上的搜尋或輸入框</span>
      </p>
      <p>
        <span className="inline-block w-64 text-ink">Enter · Esc · ⌘Enter</span>
        <span className="font-sans">DNS 表格：編輯、取消、儲存</span>
      </p>
    </div>
  );
}

async function dig(name: string): Promise<ReactNode> {
  if (name === "dev-in.tw" || name === "") {
    return (
      <div>
        <pre className="text-magpie">{MAGPIE_ASCII}</pre>
        <p className="mt-2 text-ink-muted">;; ANSWER SECTION:</p>
        {SYSTEM_RECORDS.map((r) => (
          <p key={r} className="text-ink">
            {r}
          </p>
        ))}
      </div>
    );
  }
  try {
    const res = await api("getPropagation", {
      params: { name },
      query: { recordName: "@", type: "A" },
    });
    return (
      <div>
        <p className="text-ink-muted">
          ;; {res.fqdn}. IN {res.type}（期望：{res.expected.join(" ") || "無"}）
        </p>
        {res.resolvers.map((r) => (
          <p key={r.id} className={r.matches ? "text-signal" : "text-amber"}>
            {r.matches ? "✓" : "…"} {r.label.padEnd(20)}{" "}
            {r.answers.join(" ") || (r.error ?? "尚未看到")}
          </p>
        ))}
      </div>
    );
  } catch (error) {
    if (
      !isApiError(error, "NOT_FOUND") &&
      !isApiError(error, "UNAUTHENTICATED") &&
      !isApiError(error, "NOT_IMPLEMENTED")
    ) {
      return <Line tone="danger">;; {errorMessage(error)}</Line>;
    }
  }
  try {
    const a = await api("checkAvailability", { params: { name } });
    const copy = t.availability[a.status];
    return (
      <div>
        <p className="text-ink-muted">;; -&gt;&gt;HEADER&lt;&lt;- status: {copy.code}</p>
        <p className={a.status === "available" ? "text-signal" : "text-ink"}>
          ;; {a.fqdn}：{copy.text}
          {a.status === "available" ? `（輸入 claim ${a.name} 申請）` : ""}
        </p>
      </div>
    );
  } catch (error) {
    return <Line tone="danger">;; {errorMessage(error)}</Line>;
  }
}
