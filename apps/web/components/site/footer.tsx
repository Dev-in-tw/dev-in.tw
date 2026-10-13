import Link from "next/link";
import { LogoMark } from "@/components/brand/logo.tsx";
import { SITE } from "@/lib/site.ts";

/** zone file 的 SOA serial：YYYYMMDDnn，取自 build 時間 */
function serial(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}01`;
}

const COLUMNS: { title: string; links: { href: string; label: string; external?: boolean }[] }[] = [
  {
    title: "產品",
    links: [
      { href: "/", label: "申請子網域" },
      { href: "/explore", label: "成員展示" },
      { href: "/docs", label: "使用文件" },
      { href: "/status", label: "服務狀態" },
    ],
  },
  {
    title: "規範",
    links: [
      { href: "/terms", label: "服務條款" },
      { href: "/privacy", label: "隱私權政策" },
      { href: "/aup", label: "使用規範" },
      { href: "/report", label: "檢舉濫用" },
    ],
  },
  {
    title: "社群",
    links: [
      { href: SITE.github, label: "GitHub", external: true },
      { href: "/.well-known/security.txt", label: "security.txt", external: true },
      { href: `mailto:${SITE.emails.hello}`, label: SITE.emails.hello, external: true },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-rule bg-surface">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <LogoMark className="size-8" />
            <span className="zone font-semibold">
              dev-in<span className="text-beak">.</span>tw
            </span>
          </div>
          <p className="max-w-xs text-sm text-ink-muted">
            專案名稱 Dev-in.tw，由 {SITE.operator}營運，Lazco 組成的小組負責維運。原始碼以 AGPL-3.0
            授權公開。
          </p>
          <pre className="zone overflow-x-auto text-[0.72rem] leading-relaxed text-ink-muted">
            {`@  IN  SOA  ns.dev-in.tw. ${SITE.emails.hello.replace("@", ".")}. (\n          ${serial()} ; serial\n          3600 ; refresh )`}
          </pre>
        </div>
        {COLUMNS.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <h2 className="zone text-sm font-semibold text-ink">
              <span className="text-beak" aria-hidden>
                ;{" "}
              </span>
              {col.title}
            </h2>
            <ul className="mt-3 space-y-2 text-sm">
              {col.links.map((link) => (
                <li key={link.href}>
                  {link.external ? (
                    <a href={link.href} className="text-ink-muted hover:text-ink hover:underline">
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      href={link.href}
                      className="text-ink-muted hover:text-ink hover:underline"
                    >
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-rule">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-ink-muted sm:px-6">
          <p>© {new Date().getFullYear()} Lazco Labs · 拉資科科技有限公司</p>
          <p>
            濫用回報{" "}
            <a className="link" href={`mailto:${SITE.emails.abuse}`}>
              {SITE.emails.abuse}
            </a>{" "}
            · 資安通報{" "}
            <a className="link" href={`mailto:${SITE.emails.security}`}>
              {SITE.emails.security}
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
