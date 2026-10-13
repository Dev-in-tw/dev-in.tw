/** 文件目錄（content/docs/*.mdx）。順序就是側欄的順序。 */
export const DOCS = [
  {
    slug: "getting-started",
    title: "快速開始",
    description: "從登入、申請到網站上線，五分鐘走一遍。",
  },
  {
    slug: "github-pages",
    title: "GitHub Pages",
    description: "把子網域指向 GitHub Pages，含網域驗證。",
  },
  { slug: "vercel", title: "Vercel", description: "在 Vercel 加上自訂網域並設定 CNAME。" },
  { slug: "netlify", title: "Netlify", description: "用 CNAME 把子網域接到 Netlify 網站。" },
  {
    slug: "cloudflare-pages",
    title: "Cloudflare Pages",
    description: "用 CNAME 把子網域接到 Pages 專案。",
  },
  { slug: "email", title: "Email 轉寄", description: "用 ImprovMX 讓 hi@你.dev-in.tw 收得到信。" },
  { slug: "bluesky", title: "Bluesky handle", description: "把 @你.dev-in.tw 當作 Bluesky 帳號。" },
  { slug: "faq", title: "常見問題", description: "TTL、傳播、HTTPS、配額與審核。" },
] as const;

export type DocSlug = (typeof DOCS)[number]["slug"];

export function findDoc(slug: string) {
  return DOCS.find((d) => d.slug === slug);
}
