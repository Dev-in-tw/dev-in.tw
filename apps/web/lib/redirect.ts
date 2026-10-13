/** 只允許站內相對路徑（與後端 /auth/github/start 的 redirect 驗證一致，PLAN §3.7） */
export function safeRedirect(
  raw: string | string[] | undefined | null,
  fallback = "/dashboard",
): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value?.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }
  if (value.length > 200) return fallback;
  return value;
}
