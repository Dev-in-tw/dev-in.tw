"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn.ts";

const ITEMS = [
  { href: "/admin", label: "總覽" },
  { href: "/admin/review", label: "審核" },
  { href: "/admin/reports", label: "檢舉" },
  { href: "/admin/subdomains", label: "子網域" },
  { href: "/admin/users", label: "使用者" },
  { href: "/admin/reserved", label: "保留字" },
  { href: "/admin/audit", label: "稽核" },
  { href: "/admin/zone", label: "Zone" },
  { href: "/admin/settings", label: "系統設定" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="管理後台" className="mt-2 flex gap-1 overflow-x-auto border-b border-rule">
      {ITEMS.map((item) => {
        const active =
          item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2.5 text-[0.95rem] whitespace-nowrap",
              active
                ? "border-beak font-medium text-ink"
                : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
