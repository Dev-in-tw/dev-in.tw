import localFont from "next/font/local";

// Latin 用 Geist（已子集化到 Latin、標點、箭頭與方框字元）；CJK 交給系統字型（PingFang TC、
// Noto Sans TC、微軟正黑體），不下載數 MB 的中文 webfont，LCP 才守得住。
export const geist = localFont({
  src: "../app/fonts/Geist-Variable.woff2",
  variable: "--font-geist",
  weight: "100 900",
  display: "swap",
});

export const geistMono = localFont({
  src: "../app/fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});
