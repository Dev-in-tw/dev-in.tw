import type { DnsRecord, RecordInput, RecordType } from "@dit/contract";

/**
 * DNS 編輯器的表單邏輯（純函式，給元件與 Vitest 共用）。
 * 格式驗證用合約的 zod schema（見 record-validate.ts），這裡只負責草稿 ↔ RecordInput 的轉換與顯示。
 */
export interface RecordDraft {
  type: RecordType;
  name: string;
  ttl: string;
  address: string;
  target: string;
  value: string;
  priority: string;
  exchange: string;
  weight: string;
  port: string;
  flags: string;
  tag: string;
}

export const TTL_OPTIONS = [
  { value: "1", label: "自動" },
  { value: "60", label: "1 分" },
  { value: "300", label: "5 分" },
  { value: "3600", label: "1 時" },
  { value: "86400", label: "1 天" },
] as const;

export function emptyDraft(type: RecordType = "CNAME"): RecordDraft {
  return {
    type,
    name: "@",
    ttl: "1",
    address: "",
    target: "",
    value: "",
    priority: "10",
    exchange: "",
    weight: "5",
    port: "",
    flags: "0",
    tag: "issue",
  };
}

export function draftFromRecord(r: RecordInput): RecordDraft {
  const d = { ...emptyDraft(r.type), name: r.name, ttl: String(r.ttl) };
  switch (r.type) {
    case "A":
    case "AAAA":
      return { ...d, address: r.address };
    case "CNAME":
      return { ...d, target: r.target };
    case "TXT":
      return { ...d, value: r.value };
    case "MX":
      return { ...d, priority: String(r.priority), exchange: r.exchange };
    case "SRV":
      return {
        ...d,
        priority: String(r.priority),
        weight: String(r.weight),
        port: String(r.port),
        target: r.target,
      };
    case "CAA":
      return { ...d, flags: String(r.flags), tag: r.tag, value: r.value };
  }
}

/** 主機名：使用者常會貼上結尾的點或大寫，送出前正規化 */
export function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));

/** 把草稿轉成 RecordInput 形狀（尚未驗證；數字欄位無法解析時給 NaN，讓 schema 報錯） */
export function toInput(d: RecordDraft): Record<string, unknown> {
  const base = { type: d.type, name: d.name.trim().toLowerCase() || "@", ttl: Number(d.ttl) };
  switch (d.type) {
    case "A":
    case "AAAA":
      return { ...base, address: d.address.trim() };
    case "CNAME":
      return { ...base, target: normalizeHost(d.target) };
    case "TXT":
      return { ...base, value: d.value };
    case "MX":
      return { ...base, priority: num(d.priority), exchange: normalizeHost(d.exchange) };
    case "SRV":
      return {
        ...base,
        priority: num(d.priority),
        weight: num(d.weight),
        port: num(d.port),
        target: normalizeHost(d.target),
      };
    case "CAA":
      return { ...base, flags: num(d.flags), tag: d.tag, value: d.value };
  }
}

/** 每種類型顯示的欄位（依序） */
export const FIELDS: Record<RecordType, (keyof RecordDraft)[]> = {
  A: ["address"],
  AAAA: ["address"],
  CNAME: ["target"],
  TXT: ["value"],
  MX: ["priority", "exchange"],
  SRV: ["priority", "weight", "port", "target"],
  CAA: ["flags", "tag", "value"],
};

export const FIELD_META: Record<
  string,
  {
    label: string;
    placeholder: (t: RecordType) => string;
    inputMode?: "decimal" | "numeric" | "text";
  }
> = {
  address: {
    label: "位址",
    placeholder: (t) => (t === "A" ? "185.199.108.153" : "2606:50c0:8000::153"),
    inputMode: "decimal",
  },
  target: { label: "目標", placeholder: (t) => (t === "SRV" ? "mc.example.net" : "you.github.io") },
  value: { label: "值", placeholder: (t) => (t === "CAA" ? "letsencrypt.org" : "v=spf1 -all") },
  priority: { label: "優先序", placeholder: () => "10", inputMode: "numeric" },
  exchange: { label: "郵件主機", placeholder: () => "mx1.improvmx.com" },
  weight: { label: "權重", placeholder: () => "5", inputMode: "numeric" },
  port: { label: "埠號", placeholder: () => "25565", inputMode: "numeric" },
  flags: { label: "旗標", placeholder: () => "0", inputMode: "numeric" },
  tag: { label: "標籤", placeholder: () => "issue" },
};

export function recordValue(r: RecordInput): string {
  switch (r.type) {
    case "A":
    case "AAAA":
      return r.address;
    case "CNAME":
      return r.target;
    case "TXT":
      return r.value;
    case "MX":
      return `${r.priority} ${r.exchange}`;
    case "SRV":
      return `${r.priority} ${r.weight} ${r.port} ${r.target}`;
    case "CAA":
      return `${r.flags} ${r.tag} "${r.value}"`;
  }
}

export function ttlLabel(ttl: number): string {
  return TTL_OPTIONS.find((o) => Number(o.value) === ttl)?.label ?? `${ttl}s`;
}

export function fqdnOf(name: string, sub: string, root = "dev-in.tw"): string {
  const n = name.trim().toLowerCase();
  return !n || n === "@" ? `${sub}.${root}` : `${n}.${sub}.${root}`;
}

/** 單行 zone file：`www  300  IN  CNAME  alice.github.io.`（主機名補上結尾的點，TXT 加引號） */
export function zoneLine(r: RecordInput): string {
  const ttl = r.ttl === 1 ? 300 : r.ttl;
  let data: string;
  switch (r.type) {
    case "A":
    case "AAAA":
      data = r.address;
      break;
    case "CNAME":
      data = `${r.target}.`;
      break;
    case "TXT":
      data = `"${r.value.replaceAll('"', '\\"')}"`;
      break;
    case "MX":
      data = `${r.priority} ${r.exchange}.`;
      break;
    case "SRV":
      data = `${r.priority} ${r.weight} ${r.port} ${r.target}.`;
      break;
    case "CAA":
      data = `${r.flags} ${r.tag} "${r.value}"`;
      break;
  }
  return `${r.name.padEnd(12)} ${String(ttl).padEnd(6)} IN  ${r.type.padEnd(6)} ${data}`;
}

/** 整份 zone file（只含已同步與同步中的紀錄），給「複製成 zone file」用 */
export function zoneFile(sub: string, records: readonly DnsRecord[], root = "dev-in.tw"): string {
  const lines = records.filter((r) => r.syncStatus !== "deleting").map(zoneLine);
  return [`$ORIGIN ${sub}.${root}.`, "$TTL 300", ...lines].join("\n");
}

/** `dig` 指令，方便使用者自己驗證 */
export function digCommand(r: Pick<DnsRecord, "fqdn" | "type">): string {
  return `dig +short ${r.fqdn} ${r.type} @1.1.1.1`;
}

/** 依名稱建立 zone tree：@ 在最上面，其餘依 label 由右到左分層 */
export interface TreeNode {
  label: string;
  path: string;
  types: RecordType[];
  children: TreeNode[];
}

export function zoneTree(records: readonly Pick<DnsRecord, "name" | "type">[]): TreeNode {
  const root: TreeNode = { label: "@", path: "@", types: [], children: [] };
  for (const r of records) {
    if (r.name === "@") {
      if (!root.types.includes(r.type)) root.types.push(r.type);
      continue;
    }
    const labels = r.name.split(".").reverse();
    let node = root;
    labels.forEach((label, i) => {
      const path = labels
        .slice(0, i + 1)
        .reverse()
        .join(".");
      let child = node.children.find((c) => c.label === label);
      if (!child) {
        child = { label, path, types: [], children: [] };
        node.children.push(child);
        node.children.sort((a, b) => a.label.localeCompare(b.label));
      }
      node = child;
    });
    if (!node.types.includes(r.type)) node.types.push(r.type);
  }
  return root;
}
