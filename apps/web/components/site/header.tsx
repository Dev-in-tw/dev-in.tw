import Link from "next/link";
import { Logo } from "@/components/brand/logo.tsx";
import { CommandTrigger } from "@/components/command/trigger.tsx";
import { ThemeCycle } from "@/components/theme-cycle.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";

const NAV = [
  { href: "/explore", label: "成員" },
  { href: "/docs", label: "文件" },
  { href: "/status", label: "狀態" },
];

export function SiteHeader({ className }: { className?: string }) {
  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b border-rule bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] backdrop-blur-md",
        className,
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="rounded-md" aria-label="Dev-in.tw 首頁">
          <Logo />
        </Link>
        <nav aria-label="主要導覽" className="ml-4 hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-1.5 text-[0.95rem] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <CommandTrigger />
          <ThemeCycle />
          <Link href="/dashboard" className={cn(buttonVariants({ size: "sm" }), "ml-1")}>
            控制台
          </Link>
        </div>
      </div>
      <nav
        aria-label="主要導覽（行動版）"
        className="flex gap-1 overflow-x-auto border-t border-rule px-3 py-1.5 md:hidden"
      >
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-md px-3 py-1 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
