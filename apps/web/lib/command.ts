/**
 * ⌘K 指令面板的解析器（純函式，Vitest 測試）。
 *
 *   claim <name>                     查名字並進入申請流程
 *   go <name>                        前往自己的子網域
 *   add <type> <name> <value> [ttl]  開啟已預填的新增列
 *   dig <name>                       顯示傳播結果（dig dev-in.tw 有彩蛋）
 *   theme light|dark|system          切換主題
 *   logout | help
 */
export type TokenRole = "command" | "type" | "name" | "value" | "ttl" | "arg" | "error" | "space";
export interface Token {
  text: string;
  role: TokenRole;
}

export type ParsedCommand =
  | { kind: "empty" }
  | { kind: "claim"; name: string }
  | { kind: "go"; name: string }
  | { kind: "add"; type: string; name: string; value: string; ttl?: number }
  | { kind: "dig"; name: string }
  | { kind: "theme"; theme: "light" | "dark" | "system" }
  | { kind: "logout" }
  | { kind: "help" }
  | { kind: "incomplete"; command: string; usage: string }
  | { kind: "unknown"; input: string };

export const COMMANDS = [
  { name: "claim", usage: "claim <name>", description: "查名字並申請" },
  { name: "go", usage: "go <name>", description: "前往自己的子網域" },
  { name: "add", usage: "add <type> <name> <value> [ttl]", description: "新增 DNS 紀錄" },
  { name: "dig", usage: "dig <name>", description: "查看傳播結果" },
  { name: "theme", usage: "theme light|dark|system", description: "切換主題" },
  { name: "logout", usage: "logout", description: "登出" },
  { name: "help", usage: "help", description: "顯示所有指令與快捷鍵" },
] as const;

const TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA"];
const TTL_WORDS: Record<string, number> = { auto: 1, "1m": 60, "5m": 300, "1h": 3600, "1d": 86400 };

/** 依空白切成 token，保留空白讓上色後的文字和輸入框完全對齊 */
function split(input: string): string[] {
  return input.match(/\s+|"[^"]*"?|\S+/g) ?? [];
}

const unquote = (s: string) => s.replace(/^"|"$/g, "");

export function parseTtl(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower in TTL_WORDS) return TTL_WORDS[lower];
  const n = Number(lower);
  return Number.isInteger(n) && (n === 1 || (n >= 60 && n <= 86_400)) ? n : Number.NaN;
}

function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/\.dev-in\.tw\.?$/, "");
}

export function tokenize(input: string): Token[] {
  const parts = split(input);
  const words = parts.filter((p) => !/^\s+$/.test(p));
  const command = words[0]?.toLowerCase();
  let wordIndex = -1;
  return parts.map((text) => {
    if (/^\s+$/.test(text)) return { text, role: "space" };
    wordIndex += 1;
    if (wordIndex === 0) {
      return { text, role: COMMANDS.some((c) => c.name === command) ? "command" : "error" };
    }
    if (command === "add") {
      if (wordIndex === 1)
        return { text, role: TYPES.includes(text.toUpperCase()) ? "type" : "error" };
      if (wordIndex === 2) return { text, role: "name" };
      if (wordIndex === 3) return { text, role: "value" };
      if (wordIndex === 4) return { text, role: Number.isNaN(parseTtl(text)) ? "error" : "ttl" };
      return { text, role: "error" };
    }
    if (command === "theme") {
      return {
        text,
        role: ["light", "dark", "system"].includes(text.toLowerCase()) ? "arg" : "error",
      };
    }
    return { text, role: wordIndex === 1 ? "name" : "error" };
  });
}

export function parseCommand(input: string): ParsedCommand {
  const words = split(input.trim()).filter((p) => !/^\s+$/.test(p));
  if (words.length === 0) return { kind: "empty" };
  const [head = "", ...rest] = words;
  const command = head.toLowerCase();
  const usage = COMMANDS.find((c) => c.name === command)?.usage ?? "";
  switch (command) {
    case "claim":
    case "go":
    case "dig": {
      const name = rest[0] ? normalizeName(unquote(rest[0])) : "";
      if (!name) return { kind: "incomplete", command, usage };
      return { kind: command, name };
    }
    case "add": {
      const [type, name, ...valueParts] = rest;
      if (!type || !name || valueParts.length === 0) return { kind: "incomplete", command, usage };
      const upper = type.toUpperCase();
      if (!TYPES.includes(upper)) return { kind: "incomplete", command, usage };
      // MX 的值可以是「10 mx1.example.com」：最後一個 token 若是合法 TTL 才當 TTL
      let ttl: number | undefined;
      const last = valueParts.at(-1);
      if (
        valueParts.length > 1 &&
        last &&
        !Number.isNaN(parseTtl(last)) &&
        parseTtl(last) !== undefined &&
        upper !== "MX"
      ) {
        ttl = parseTtl(last);
        valueParts.pop();
      }
      const value = unquote(valueParts.join(" "));
      return ttl === undefined
        ? { kind: "add", type: upper, name: name.toLowerCase(), value }
        : { kind: "add", type: upper, name: name.toLowerCase(), value, ttl };
    }
    case "theme": {
      const theme = rest[0]?.toLowerCase();
      if (theme === "light" || theme === "dark" || theme === "system")
        return { kind: "theme", theme };
      return { kind: "incomplete", command, usage };
    }
    case "logout":
      return { kind: "logout" };
    case "help":
      return { kind: "help" };
    default:
      return { kind: "unknown", input: input.trim() };
  }
}

/** add 指令轉成 DNS 編輯器的預填網址 */
export function addHref(sub: string, cmd: Extract<ParsedCommand, { kind: "add" }>): string {
  const params = new URLSearchParams({ add: cmd.type, name: cmd.name, value: cmd.value });
  if (cmd.ttl !== undefined) params.set("ttl", String(cmd.ttl));
  return `/dashboard/${encodeURIComponent(sub)}/records?${params.toString()}`;
}

export const MAGPIE_ASCII = String.raw`
            ___
        _.-'   '-._        台灣藍鵲  Urocissa caerulea
      .'  (o)      '.      ──────────────────────────
     /   _____       \     鵲藍的身體、鵲喙紅的嘴
    |  <______)  ~~~  |    整個 dev-in.tw 都是牠的地盤
     \     \\\       /
      '.    \\\    .'~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
        '-._ \\\ _.'   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
            ''''          (尾羽白色的末端在這裡 ↗)`;

export const SYSTEM_RECORDS = [
  "dev-in.tw.        300  IN  A      (Lazco Dokploy)",
  "www.dev-in.tw.    300  IN  CNAME  dev-in.tw.",
  "dev-in.tw.        300  IN  MX     (Cloudflare Email Routing)",
  '_dmarc.dev-in.tw. 300  IN  TXT    "v=DMARC1; p=reject"',
];
