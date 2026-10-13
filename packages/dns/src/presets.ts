import {
  type DnsRecord,
  HOSTNAME_RE,
  type Preset,
  type PresetId,
  RECORD_NAME_RE,
  type RecordInput,
} from "@dit/contract";
import { describeRecord, isSameRecord } from "./record-data.ts";
import type { Verdict, Violation } from "./types.ts";

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

/** preset 產生的紀錄一律用 TTL 1（自動） */
export const PRESET_TTL = 1;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const GOOGLE_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

type Params = Record<string, string>;
type Builder = (
  p: Params,
  ctx: PresetContext,
  bad: (key: string, msg: string) => void,
) => RecordInput[];

/** "@" 底下的 `_atproto` 之類的前綴名稱："@" → "_atproto"，"blog" → "_atproto.blog" */
export function prefixedName(prefix: string, recordName: string): string {
  return recordName === "@" ? prefix : `${prefix}.${recordName}`;
}

const host = (value: string) => value.trim().toLowerCase().replace(/\.$/, "");

function cname(name: string, target: string): RecordInput {
  return { type: "CNAME", name, ttl: PRESET_TTL, target };
}
function txt(name: string, value: string): RecordInput {
  return { type: "TXT", name, ttl: PRESET_TTL, value };
}

/** 檢查使用者貼上的主機名稱，不合法時回 null 並記錄錯誤 */
function hostParam(p: Params, key: string, bad: (key: string, msg: string) => void): string | null {
  const value = host(p[key] ?? "");
  if (!HOSTNAME_RE.test(value)) {
    bad(key, "必須是合法的主機名稱，例如 my-app.example.com");
    return null;
  }
  return value;
}

function txtParam(p: Params, key: string, bad: (key: string, msg: string) => void): string | null {
  const value = (p[key] ?? "").trim();
  if (value === "") return null;
  if (value.length > 255 || !PRINTABLE_ASCII.test(value)) {
    bad(key, "只能是 255 個字元以內的可列印 ASCII 字元");
    return null;
  }
  return value;
}

const BUILDERS: Record<PresetId, Builder> = {
  "github-pages": (p, ctx, bad) => {
    const user = (p.githubUser ?? "").toLowerCase();
    const out = [cname(ctx.recordName, `${user}.github.io`)];
    const token = txtParam(p, "verifyToken", bad);
    if (token !== null) out.push(txt(`_github-pages-challenge-${user}`, token));
    return out;
  },
  vercel: (p, ctx, bad) => {
    const target = p.target ? hostParam(p, "target", bad) : "cname.vercel-dns.com";
    const out = target === null ? [] : [cname(ctx.recordName, target)];
    const verify = txtParam(p, "verifyTxt", bad);
    if (verify !== null) out.push(txt("_vercel", verify));
    return out;
  },
  netlify: (p, ctx) => [cname(ctx.recordName, `${p.site}.netlify.app`)],
  "cloudflare-pages": (p, ctx) => [cname(ctx.recordName, `${p.project}.pages.dev`)],
  zeabur: (p, ctx, bad) => {
    const target = hostParam(p, "target", bad);
    return target === null ? [] : [cname(ctx.recordName, target)];
  },
  render: (p, ctx, bad) => {
    const target = hostParam(p, "target", bad);
    return target === null ? [] : [cname(ctx.recordName, target)];
  },
  fly: (p, ctx) => [cname(ctx.recordName, `${p.app}.fly.dev`)],
  bluesky: (p, ctx) => [txt(prefixedName("_atproto", ctx.recordName), `did=${p.did}`)],
  improvmx: (_p, ctx) => [
    {
      type: "MX",
      name: ctx.recordName,
      ttl: PRESET_TTL,
      priority: 10,
      exchange: "mx1.improvmx.com",
    },
    {
      type: "MX",
      name: ctx.recordName,
      ttl: PRESET_TTL,
      priority: 20,
      exchange: "mx2.improvmx.com",
    },
    txt(ctx.recordName, "v=spf1 include:spf.improvmx.com ~all"),
  ],
  "google-site-verification": (p, ctx, bad) => {
    const token = (p.token ?? "").trim().replace(/^google-site-verification=/, "");
    if (!GOOGLE_TOKEN_RE.test(token)) {
      bad("token", "驗證碼格式不正確，請貼上 google-site-verification= 後面的值");
      return [];
    }
    return [txt(ctx.recordName, `google-site-verification=${token}`)];
  },
};

const isSpf = (r: RecordInput) => r.type === "TXT" && r.value.startsWith("v=spf1");

/** 既有紀錄 `old` 是否會和 preset 要新增的 `create` 衝突（套用時要一併刪除） */
function supersedes(create: RecordInput, old: DnsRecord): boolean {
  if (old.name !== create.name) return false;
  if (create.type === "CNAME" || old.type === "CNAME") return true;
  if (create.type === "MX" && old.type === "MX") return true; // 換一家郵件服務
  return isSpf(create) && isSpf(old); // 同一個名稱只能有一筆 SPF
}

/**
 * 依 preset 參數產生要新增與刪除的紀錄（§3.9 Presets）。
 *
 * - 參數不合法時回 Verdict（code 一律 PRESET_PARAMS_INVALID，path 為 `params.<key>`）。
 * - 和新紀錄衝突的既有紀錄放進 deletes（CNAME 排他、MX 換手、SPF 只能一筆），並附上 warnings。
 * - 已經存在完全相同的紀錄時，不重複新增，只加一則 warning。
 * - 產生的紀錄仍要由呼叫端（API）以 validateRecord 做完整檢查，例如 CNAME 指向的子網域擁有權。
 */
export function planPreset(
  id: PresetId,
  params: Record<string, string>,
  ctx: PresetContext,
): PresetPlanResult | Verdict {
  const preset = PRESETS.find((p) => p.id === id);
  const violations: Violation[] = [];
  const bad = (key: string, message: string) =>
    violations.push({ path: `params.${key}`, code: "PRESET_PARAMS_INVALID", message });

  if (!preset) {
    return {
      ok: false,
      violations: [
        { path: "presetId", code: "PRESET_PARAMS_INVALID", message: "沒有這個一鍵設定" },
      ],
    };
  }
  if (!RECORD_NAME_RE.test(ctx.recordName)) {
    violations.push({
      path: "recordName",
      code: "PRESET_PARAMS_INVALID",
      message: "紀錄名稱必須是 @ 或合法的相對名稱",
    });
  }

  const resolved: Params = {};
  for (const param of preset.params as Preset["params"]) {
    let value = (params[param.key] ?? "").trim();
    if (value === "" && param.defaultFrom === "githubLogin") value = ctx.githubLogin;
    if (value === "") {
      if (param.required) bad(param.key, `「${param.label}」是必填欄位`);
      continue;
    }
    if (param.pattern !== undefined && !new RegExp(param.pattern).test(value)) {
      bad(param.key, `「${param.label}」的格式不正確`);
      continue;
    }
    resolved[param.key] = value;
  }
  if (violations.length > 0) return { ok: false, violations };

  const generated = BUILDERS[id](resolved, ctx, bad);
  if (violations.length > 0) return { ok: false, violations };

  const creates: RecordInput[] = [];
  const deletes = new Map<string, DnsRecord>();
  const warnings: string[] = [];
  for (const create of generated) {
    const same = ctx.existing.find((old) => isSameRecord(old, create));
    if (same) {
      warnings.push(`已有相同的紀錄 ${describeRecord(same)}，不會重複新增`);
      continue;
    }
    creates.push(create);
    for (const old of ctx.existing) {
      if (deletes.has(old.id) || !supersedes(create, old)) continue;
      if (generated.some((g) => isSameRecord(old, g))) continue; // 要保留的相同紀錄
      deletes.set(old.id, old);
      warnings.push(`現有的 ${old.name} ${old.type} 會和 ${create.type} 衝突，套用時一併刪除`);
    }
  }
  return { creates, deletes: [...deletes.values()], warnings };
}
