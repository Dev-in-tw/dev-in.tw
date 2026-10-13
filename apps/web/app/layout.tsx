import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers.tsx";
import { geist, geistMono } from "@/lib/fonts.ts";
import { SITE } from "@/lib/site.ts";
import { THEME_SCRIPT } from "@/lib/theme-script.ts";

export const metadata: Metadata = {
  metadataBase: new URL(SITE.origin),
  title: { default: "Dev-in.tw — 給臺灣開發者的一個名字", template: "%s · Dev-in.tw" },
  description: SITE.description,
  applicationName: "Dev-in.tw",
  openGraph: {
    type: "website",
    locale: "zh_TW",
    siteName: "Dev-in.tw",
    title: "Dev-in.tw — 給臺灣開發者的一個名字",
    description: SITE.description,
  },
  twitter: { card: "summary_large_image" },
  alternates: { canonical: "/" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f5" },
    { media: "(prefers-color-scheme: dark)", color: "#0f131c" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="zh-Hant"
      suppressHydrationWarning
      className={`${geist.variable} ${geistMono.variable}`}
    >
      <head>
        {/* 在第一次繪製前套用主題；內容固定，nonce 頁面以 sha256 放行（見 proxy.ts） */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 固定字串，非使用者輸入 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only z-[100] rounded-md bg-primary px-4 py-2 text-primary-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          跳到主要內容
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
