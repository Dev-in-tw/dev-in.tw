const TZ = "Asia/Taipei";

const dateTime = new Intl.DateTimeFormat("zh-TW", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dateOnly = new Intl.DateTimeFormat("zh-TW", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const timeOnly = new Intl.DateTimeFormat("zh-TW", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });

/**
 * 批次寫入 DNS 時（Lazco DNS）pending 紀錄的預計生效時間：「預計 14:32 前生效」，不是今天就加上日期。
 * 只是估計：實際時間還受 TTL 與各家 DNS 快取影響。
 */
export function syncEtaLabel(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const sameDay = dayKey.format(at) === dayKey.format(new Date(now));
  return `預計 ${sameDay ? timeOnly.format(at) : formatDateTime(iso)} 前生效`;
}

/** 一律以台北時間顯示（zone file 風格：2026/10/14 16:00） */
export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function formatDate(iso: string): string {
  return dateOnly.format(new Date(iso));
}

const rtf = new Intl.RelativeTimeFormat("zh-TW", { numeric: "auto" });

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = (Date.parse(iso) - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "剛剛";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86_400 * 30) return rtf.format(Math.round(diff / 86_400), "day");
  return formatDate(iso);
}

/** 依台北時間打招呼 */
export function greeting(now = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(now),
  );
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早安";
  if (hour < 14) return "午安";
  if (hour < 18) return "午後好";
  return "晚安";
}
