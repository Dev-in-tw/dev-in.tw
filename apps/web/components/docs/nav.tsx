"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn.ts";
import { DOCS } from "@/lib/docs.ts";

export function DocsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="文件" className="lg:sticky lg:top-24 lg:self-start">
      <p className="zone text-sm text-ink-muted">
        <span className="text-beak">;</span> docs
      </p>
      <ul className="mt-3 flex gap-1 overflow-x-auto lg:flex-col">
        <li>
          <Link
            href="/docs"
            aria-current={pathname === "/docs" ? "page" : undefined}
            className={cn(
              "block rounded-md px-3 py-1.5 text-sm whitespace-nowrap",
              pathname === "/docs" ? "bg-surface-2 font-medium" : "text-ink-muted hover:text-ink",
            )}
          >
            總覽
          </Link>
        </li>
        {DOCS.map((d) => {
          const href = `/docs/${d.slug}`;
          const active = pathname === href;
          return (
            <li key={d.slug}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block rounded-md px-3 py-1.5 text-sm whitespace-nowrap",
                  active ? "bg-surface-2 font-medium" : "text-ink-muted hover:text-ink",
                )}
              >
                {d.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
