/**
 * 只允許站內相對路徑（與後端 /auth/github/start 的 sanitizeRedirect 一致，PLAN §3.7）。
 * 瀏覽器解析網址時會丟掉 tab 與換行、把 `\` 當成 `/`，所以 `/\t/evil.com`、`/%5Cevil.com` 這類值
 * 看起來是相對路徑，實際上會變成 `//evil.com`。這裡擋掉控制字元與反斜線，最後再用 URL 解析確認
 * 結果仍在同一個 origin。
 */
export function safeRedirect(
  raw: string | string[] | undefined | null,
  fallback = "/dashboard",
): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value.length > 200) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 刻意擋掉控制字元
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  try {
    const base = "https://placeholder.invalid";
    if (new URL(value, base).origin !== base) return fallback;
  } catch {
    return fallback;
  }
  return value;
}
