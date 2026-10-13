"use client";

import { ArrowLeftRight, BookOpen, LayoutGrid, LogOut, Settings, Shield } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Logo } from "@/components/brand/logo.tsx";
import { CommandTrigger } from "@/components/command/trigger.tsx";
import { ThemeToggle } from "@/components/theme-toggle.tsx";
import { api } from "@/lib/api/client.ts";
import { cn } from "@/lib/cn.ts";
import { useMe } from "@/lib/me.tsx";
import { useSync } from "@/lib/sse.tsx";
import { Avatar } from "./avatar.tsx";

function useItems() {
  const me = useMe();
  const items = [
    { href: "/dashboard", label: "總覽", icon: LayoutGrid, exact: true },
    {
      href: "/dashboard/transfers",
      label: "轉移",
      icon: ArrowLeftRight,
      badge: me.incomingTransfers,
    },
    { href: "/settings", label: "設定", icon: Settings },
    { href: "/docs", label: "文件", icon: BookOpen },
  ];
  if (me.role === "admin") items.push({ href: "/admin", label: "管理", icon: Shield });
  return items;
}

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact)
    return (
      pathname === href ||
      (href === "/dashboard" && /^\/dashboard\/(?!transfers)[^/]+/.test(pathname))
    );
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SyncIndicator() {
  const { mode } = useSync();
  const label = {
    connecting: "連線中",
    live: "即時同步",
    polling: "輪詢模式",
    offline: "重新連線中",
  }[mode];
  return (
    <p
      className="zone flex items-center gap-2 text-xs text-ink-muted"
      title="DNS 同步狀態的即時連線"
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          mode === "live" && "bg-signal shadow-[0_0_0_3px_var(--signal-soft)]",
          mode === "polling" && "bg-amber",
          (mode === "connecting" || mode === "offline") && "animate-pulse bg-field",
        )}
      />
      {label}
    </p>
  );
}

async function logout(router: ReturnType<typeof useRouter>) {
  try {
    await api("logout");
  } finally {
    router.push("/");
    router.refresh();
  }
}

export function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const me = useMe();
  const items = useItems();

  return (
    <>
      {/* 手機頂列 */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-rule bg-[color-mix(in_oklch,var(--bg)_90%,transparent)] px-4 backdrop-blur lg:hidden">
        <Link href="/dashboard" aria-label="控制台首頁">
          <Logo />
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <CommandTrigger />
          <ThemeToggle />
        </div>
      </header>

      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-rule bg-surface lg:flex">
        <div className="flex h-16 items-center px-5">
          <Link href="/" aria-label="Dev-in.tw 首頁">
            <Logo />
          </Link>
        </div>
        <div className="px-3">
          <CommandTrigger className="w-full justify-start" />
        </div>
        <nav aria-label="控制台" className="mt-4 flex-1 space-y-0.5 px-3">
          {items.map((item) => {
            const active = isActive(pathname, item.href, item.exact);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group relative flex items-center gap-3 rounded-md px-3 py-2 text-[0.95rem] transition-colors",
                  active
                    ? "bg-bg font-medium text-ink shadow-[2px_2px_0_var(--shadow)]"
                    : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                )}
              >
                {active ? (
                  <span
                    aria-hidden
                    className="absolute top-2 bottom-2 -left-3 w-1 rounded-r bg-beak"
                  />
                ) : null}
                <item.icon className="size-4" aria-hidden />
                {item.label}
                {item.badge ? (
                  <span className="zone ml-auto rounded-full bg-beak px-1.5 text-xs text-white">
                    {item.badge}
                    <span className="sr-only"> 筆待處理</span>
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-3 border-t border-rule p-4">
          <SyncIndicator />
          <div className="flex items-center gap-3">
            <Avatar src={me.avatarUrl} login={me.githubLogin} size={32} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{me.displayName ?? me.githubLogin}</p>
              <p className="zone truncate text-xs text-ink-muted">@{me.githubLogin}</p>
            </div>
            <ThemeToggle />
          </div>
          <button
            type="button"
            onClick={() => logout(router)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <LogOut className="size-4" aria-hidden />
            登出
          </button>
        </div>
      </aside>
    </>
  );
}

export function MobileTabs() {
  const pathname = usePathname();
  const items = useItems();
  return (
    <nav
      aria-label="控制台（行動版）"
      className="fixed inset-x-0 bottom-0 z-30 grid border-t border-rule bg-bg pb-[env(safe-area-inset-bottom)] lg:hidden"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((item) => {
        const active = isActive(pathname, item.href, item.exact);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-col items-center gap-0.5 py-2 text-[0.7rem]",
              active ? "text-magpie" : "text-ink-muted",
            )}
          >
            <item.icon className="size-5" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export { logout };
