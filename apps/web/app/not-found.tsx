import type { Metadata } from "next";
import Link from "next/link";
import { CommandPaletteHost } from "@/components/command/host.tsx";
import { SiteFooter } from "@/components/site/footer.tsx";
import { SiteHeader } from "@/components/site/header.tsx";
import { NxdomainSearch } from "@/components/site/nxdomain.tsx";

export const metadata: Metadata = { title: "NXDOMAIN：找不到頁面", robots: { index: false } };

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="relative outline-none">
        <div className="bg-dots pointer-events-none absolute inset-0 -z-10" aria-hidden />
        <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
          <pre className="zone overflow-x-auto text-sm text-ink-muted" aria-hidden>
            {`$ dig this-page.dev-in.tw

;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 404
;; QUESTION SECTION:
;this-page.dev-in.tw.        IN  A`}
          </pre>
          <h1 className="mt-6">
            <span className="zone block text-step-5 font-bold tracking-tight text-beak">
              NXDOMAIN
            </span>
            <span className="mt-2 block text-step-2 font-semibold">這個頁面不存在</span>
          </h1>
          <p className="mt-3 text-ink-muted">
            可能是網址打錯了，或頁面已經搬家。不過，也許這個名字還沒有人用：
          </p>
          <div className="mt-6">
            <NxdomainSearch />
          </div>
          <p className="mt-8 text-sm">
            或是回到{" "}
            <Link href="/" className="link">
              首頁
            </Link>
            、看看{" "}
            <Link href="/docs" className="link">
              文件
            </Link>
            、
            <Link href="/status" className="link">
              服務狀態
            </Link>
            。
          </p>
        </div>
      </main>
      <SiteFooter />
      <CommandPaletteHost />
    </>
  );
}
