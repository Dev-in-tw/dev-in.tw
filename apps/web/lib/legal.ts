/**
 * 法務文件（content/legal/*.mdx）的版本與生效日期，三份文件只在這裡維護。
 * 修改條文時：調整 version 與 effective，並在文件最後的「修訂紀錄」補一行。
 */
export const LEGAL_DOCS = {
  terms: {
    slug: "terms",
    title: "服務條款",
    description: "Dev-in.tw 的服務條款：子網域使用權、帳號、停權、免責與準據法。",
    version: "1.0",
    effective: "2026-10-14",
  },
  privacy: {
    slug: "privacy",
    title: "隱私權政策",
    description:
      "Dev-in.tw 依個人資料保護法說明：我們蒐集哪些資料、為什麼、存在哪裡、保存多久，以及你的權利。",
    version: "1.0",
    effective: "2026-10-14",
  },
  aup: {
    slug: "aup",
    title: "使用規範",
    description: "Dev-in.tw 的使用規範：禁止的用途、名稱規則、違規處理、檢舉與資安漏洞通報。",
    version: "1.0",
    effective: "2026-10-14",
  },
} as const;

export type LegalSlug = keyof typeof LEGAL_DOCS;
export type LegalDoc = (typeof LEGAL_DOCS)[LegalSlug];
