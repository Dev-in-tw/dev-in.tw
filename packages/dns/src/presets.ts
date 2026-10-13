import type { DnsRecord, Preset, PresetId, RecordInput } from "@dit/contract";
import type { Verdict } from "./types.ts";

const GITHUB_LOGIN_PATTERN = "^[A-Za-z\\d](?:[A-Za-z\\d]|-(?=[A-Za-z\\d])){0,38}$";
const LABEL_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$";

/** 宣告式 preset 定義（§3.9）。P1 的 preset 先標 available: false。 */
export const PRESETS = [
  {
    id: "github-pages",
    title: "GitHub Pages",
    description: "把子網域指向你的 GitHub Pages 網站",
    docsSlug: "github-pages",
    available: true,
    params: [
      {
        key: "githubUser",
        label: "GitHub 使用者或組織",
        placeholder: "octocat",
        required: true,
        pattern: GITHUB_LOGIN_PATTERN,
        defaultFrom: "githubLogin",
      },
      {
        key: "verifyToken",
        label: "網域驗證碼（選填）",
        placeholder: "GitHub 提供的 TXT 值",
        required: false,
      },
    ],
  },
  {
    id: "vercel",
    title: "Vercel",
    description: "把子網域指向 Vercel 專案",
    docsSlug: "vercel",
    available: true,
    params: [
      { key: "target", label: "CNAME 目標", placeholder: "cname.vercel-dns.com", required: false },
      {
        key: "verifyTxt",
        label: "驗證 TXT（選填）",
        placeholder: "vc-domain-verify=…",
        required: false,
      },
    ],
  },
  {
    id: "netlify",
    title: "Netlify",
    description: "把子網域指向 Netlify 網站",
    docsSlug: "netlify",
    available: true,
    params: [
      {
        key: "site",
        label: "Netlify 網站名稱",
        placeholder: "my-site",
        required: true,
        pattern: LABEL_PATTERN,
      },
    ],
  },
  {
    id: "cloudflare-pages",
    title: "Cloudflare Pages",
    description: "把子網域指向 Cloudflare Pages 專案",
    docsSlug: "cloudflare-pages",
    available: true,
    params: [
      {
        key: "project",
        label: "Pages 專案名稱",
        placeholder: "my-project",
        required: true,
        pattern: LABEL_PATTERN,
      },
    ],
  },
  {
    id: "zeabur",
    title: "Zeabur",
    description: "把子網域指向 Zeabur 服務",
    docsSlug: "zeabur",
    available: false,
    params: [
      { key: "target", label: "CNAME 目標", placeholder: "Zeabur 提供的網域", required: true },
    ],
  },
  {
    id: "render",
    title: "Render",
    description: "把子網域指向 Render 服務",
    docsSlug: "render",
    available: false,
    params: [
      { key: "target", label: "CNAME 目標", placeholder: "my-app.onrender.com", required: true },
    ],
  },
  {
    id: "fly",
    title: "Fly.io",
    description: "把子網域指向 Fly.io app",
    docsSlug: "fly",
    available: false,
    params: [
      {
        key: "app",
        label: "Fly app 名稱",
        placeholder: "my-app",
        required: true,
        pattern: LABEL_PATTERN,
      },
    ],
  },
  {
    id: "bluesky",
    title: "Bluesky handle",
    description: "用子網域當作你的 Bluesky handle",
    docsSlug: "bluesky",
    available: false,
    params: [
      {
        key: "did",
        label: "DID",
        placeholder: "did:plc:…",
        required: true,
        pattern: "^did:[a-z]+:[A-Za-z0-9._:%-]+$",
      },
    ],
  },
  {
    id: "improvmx",
    title: "ImprovMX 轉寄信箱",
    description: "用子網域收信並轉寄到你的信箱",
    docsSlug: "email",
    available: false,
    params: [],
  },
  {
    id: "google-site-verification",
    title: "Google 網站驗證",
    description: "加入 Google Search Console 的 TXT 驗證紀錄",
    docsSlug: "google-site-verification",
    available: false,
    params: [
      {
        key: "token",
        label: "驗證碼",
        placeholder: "google-site-verification= 後面的值",
        required: true,
      },
    ],
  },
] as const satisfies readonly Preset[];

export interface PresetContext {
  sub: string;
  root: string;
  recordName: string;
  githubLogin: string;
  existing: readonly DnsRecord[];
}

export type PresetPlanResult = { creates: RecordInput[]; deletes: DnsRecord[]; warnings: string[] };

/** 依 preset 參數產生要新增與刪除的紀錄（§3.9 Presets） */
export function planPreset(
  _id: PresetId,
  _params: Record<string, string>,
  _ctx: PresetContext,
): PresetPlanResult | Verdict {
  // TODO(WP-A): 依 PRESETS 產生 creates；驗證參數（失敗回 Verdict，對應 PRESET_PARAMS_INVALID）；
  // 找出與既有紀錄衝突、需要一併刪除的 deletes，並產生 warnings
  return { creates: [], deletes: [], warnings: [] };
}
