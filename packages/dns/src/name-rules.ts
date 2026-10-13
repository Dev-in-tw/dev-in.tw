import { OK, type Verdict } from "./types.ts";

/** trim、轉小寫、全形轉半形 */
export function normalizeLabel(input: string): string {
  // TODO(WP-A): 全形轉半形（NFKC）
  return input.trim().toLowerCase();
}

/** 3–32 字元、不可含 --、不可有底線（§3.9） */
export function checkLabelSyntax(_label: string): Verdict {
  // TODO(WP-A): 實作 §3.9 的名稱規則；stub 一律視為合法
  return OK;
}

/** leet 正規化：0→o、1→l/i、3→e、4→a、5→s、7→t、移除 "-" */
export function leetSkeleton(label: string): string {
  // TODO(WP-A): 實作 leet 正規化（必須冪等）
  return label;
}

/**
 * 回傳 label 近似的品牌名稱，沒有就回 null。
 * 長度 < 5 的 brand 只做完全比對；≥ 5 才做 leet、編輯距離 ≤ 1 與子字串比對（§3.9）。
 */
export function confusableWith(_label: string, _brands: readonly string[]): string | null {
  // TODO(WP-A): 實作近似比對，並通過 §3.9 的誤判防護測試
  return null;
}
