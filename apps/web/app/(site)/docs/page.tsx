import type { Metadata } from "next";
import Link from "next/link";
import { DOCS } from "@/lib/docs.ts";

export const metadata: Metadata = {
  title: "使用文件",
  description:
    "Dev-in.tw 的使用教學：GitHub Pages、Vercel、Netlify、Cloudflare Pages、Email 與常見問題。",
  alternates: { canonical: "/docs" },
};

export default function DocsIndex() {
  return (
    <>
      <h1 className="text-step-4 font-semibold tracking-tight">使用文件</h1>
      <p className="mt-3 text-ink-muted">照著做就能上線。卡住的話，常見問題裡大概有答案。</p>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2">
        {DOCS.map((d) => (
          <li key={d.slug}>
            <Link
              href={`/docs/${d.slug}`}
              className="block h-full rounded-md border border-rule bg-bg p-5 shadow-[4px_4px_0_var(--shadow)] transition-[border-color,translate] hover:-translate-y-0.5 hover:border-magpie"
            >
              <span className="font-semibold">{d.title}</span>
              <span className="mt-1 block text-sm text-ink-muted">{d.description}</span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-10 rounded-md border border-rule bg-surface p-5">
        <h2 className="font-semibold">給開發者：API 文件</h2>
        <p className="mt-1 text-sm text-ink-muted">
          所有端點都有 OpenAPI 3.1 描述：
          <a className="link" href="/api/docs">
            /api/docs
          </a>
          （互動式文件）與
          <a className="link" href="/api/openapi.json">
            /api/openapi.json
          </a>
          。目前需要登入的端點只接受瀏覽器 session；Personal Access Token 會在之後推出。
        </p>
      </div>
    </>
  );
}
