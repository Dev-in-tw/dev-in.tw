import type { Violation } from "./types.ts";
import { type Verdict, verdictOf } from "./types.ts";

export const NAME_MIN_LENGTH = 3;
export const NAME_MAX_LENGTH = 32;
/** 長度 < 5 的品牌只做完全比對（§3.9），避免 alex、online、metal 之類的一般名稱被送審 */
export const FUZZY_BRAND_MIN_LENGTH = 5;

/** trim、全形轉半形（NFKC）、轉小寫，並去掉一個結尾的點 */
export function normalizeLabel(input: string): string {
  const text = input.normalize("NFKC").replaceAll("。", ".").trim().toLowerCase();
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

/** 1–2 字元的合法名稱屬於 premium，MVP 不開放註冊 */
export function isPremiumLength(label: string): boolean {
  return /^[a-z0-9]{1,2}$/.test(label);
}

/** 3–32 字元、只能有小寫英數與連字號、頭尾不可為連字號、不可含 --（同時擋掉 xn--）（§3.9） */
export function checkLabelSyntax(label: string): Verdict {
  const violations: Violation[] = [];
  const add = (code: string, message: string) => violations.push({ path: "name", code, message });

  if (label.length < NAME_MIN_LENGTH) {
    add("NAME_TOO_SHORT", `名稱至少要 ${NAME_MIN_LENGTH} 個字元`);
  } else if (label.length > NAME_MAX_LENGTH) {
    add("NAME_TOO_LONG", `名稱最多 ${NAME_MAX_LENGTH} 個字元`);
  }
  if (!/^[a-z0-9-]*$/.test(label)) {
    add("NAME_INVALID_CHARS", "名稱只能使用小寫英文字母、數字與連字號（-），不能有底線或其他符號");
  }
  if (label.startsWith("-") || label.endsWith("-")) {
    add("NAME_EDGE_HYPHEN", "名稱不能以連字號開頭或結尾");
  }
  if (label.includes("--")) {
    add(
      "NAME_DOUBLE_HYPHEN",
      label.startsWith("xn--")
        ? "不開放國際化網域名稱（xn-- punycode），以免被用來偽裝成其他網站"
        : "名稱不能包含連續的連字號（--）",
    );
  }
  return verdictOf(violations);
}

const LEET: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "l",
  i: "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "-": "",
};

/**
 * leet 正規化：0→o、1→l、i→l（1、i、l 視為同一個字）、3→e、4→a、5→s、7→t、移除 "-"。
 * 輸出不會再含有任何可被替換的字元，所以是冪等的。
 */
export function leetSkeleton(label: string): string {
  let out = "";
  for (const char of label.toLowerCase()) out += LEET[char] ?? char;
  return out;
}

/** 兩個字串之間是否最多只差一次編輯（插入、刪除、替換，或相鄰兩字互換） */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diffs: number[] = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        diffs.push(i);
        if (diffs.length > 2) return false;
      }
    }
    if (diffs.length === 1) return true;
    const [i = 0, j = 0] = diffs;
    return j === i + 1 && a[i] === b[j] && a[j] === b[i];
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
}

/**
 * 回傳 label 近似的品牌名稱，沒有就回 null。
 * 長度 < 5 的 brand 只做完全比對；≥ 5 才做 leet、編輯距離 ≤ 1 與子字串比對（§3.9）。
 * 完全相同的品牌優先回傳。
 */
export function confusableWith(label: string, brands: readonly string[]): string | null {
  const name = normalizeLabel(label);
  const normalized = brands.map(normalizeLabel);
  const exact = normalized.find((brand) => brand === name);
  if (exact !== undefined) return exact;

  const skeleton = leetSkeleton(name);
  for (const brand of normalized) {
    if (brand.length < FUZZY_BRAND_MIN_LENGTH) continue;
    const brandSkeleton = leetSkeleton(brand);
    if (withinOneEdit(skeleton, brandSkeleton) || skeleton.includes(brandSkeleton)) return brand;
  }
  return null;
}
