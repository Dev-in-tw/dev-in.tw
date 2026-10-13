/** 站台常數（不含任何環境相依值；runtime 設定一律從 GET /api/v1/meta 取得） */
export const SITE = {
  origin: "https://dev-in.tw",
  rootDomain: "dev-in.tw",
  description:
    "用 GitHub 登入，免費申請 <name>.dev-in.tw，在網頁上管理 DNS。不收個資、不開橘雲，由 Lazco Labs 維運。",
  operator: "Lazco Labs（拉資科科技有限公司，Lazco Corporation）",
  operatorShort: "Lazco Labs",
  emails: {
    abuse: "abuse@dev-in.tw",
    security: "security@dev-in.tw",
    hello: "hello@dev-in.tw",
  },
  github: "https://github.com/Dev-in-tw/dev-in.tw",
  githubOrg: "https://github.com/Dev-in-tw",
} as const;
