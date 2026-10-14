import Link from "next/link";
import type { ReactNode } from "react";
import { LEGAL_DOCS } from "@/lib/legal.ts";
import { SITE } from "@/lib/site.ts";

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <article>{children}</article>
      <footer className="mt-16 space-y-3 border-t border-rule pt-6 text-sm text-ink-muted">
        <p>營運者：{SITE.operator}。本服務的法務文件以繁體中文版為準，英文摘要僅供參考。</p>
        <nav aria-label="法務文件">
          <ul className="flex flex-wrap gap-x-5 gap-y-1">
            {Object.values(LEGAL_DOCS).map((doc) => (
              <li key={doc.slug}>
                <Link href={`/${doc.slug}`} className="link">
                  {doc.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </footer>
    </div>
  );
}
