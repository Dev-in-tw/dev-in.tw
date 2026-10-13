import type { Logger } from "../../lib/logger.ts";
import { type FetchLike, fetchWithTimeout } from "../http.ts";

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  /** 同一個 key 在 throttle 期間內只送一次 */
  key: string;
  title: string;
  description: string;
  severity: AlertSeverity;
  fields?: { name: string; value: string; inline?: boolean }[];
  url?: string;
}

export interface Notifier {
  /** fire-and-forget：失敗只寫 log，不影響呼叫端 */
  notify(alert: Alert): void;
}

const COLORS: Record<AlertSeverity, number> = {
  info: 0x2f6fde, // 鵲藍
  warning: 0xe0a526,
  critical: 0xd1432f, // 鵲喙紅
};

/** Discord webhook（embed 格式，PLAN §3.11）。沒有設定 DISCORD_WEBHOOK_URL 時只寫 log。 */
export class DiscordNotifier implements Notifier {
  readonly #url: string | undefined;
  readonly #logger: Logger;
  readonly #fetch: FetchLike;
  readonly #throttleMs: number;
  readonly #lastSent = new Map<string, number>();
  readonly #now: () => number;
  readonly sent: Alert[] = [];

  constructor(opts: {
    webhookUrl: string | undefined;
    logger: Logger;
    fetch?: FetchLike;
    throttleMs?: number;
    now?: () => number;
  }) {
    this.#url = opts.webhookUrl;
    this.#logger = opts.logger;
    this.#fetch = opts.fetch ?? fetch;
    this.#throttleMs = opts.throttleMs ?? 10 * 60_000;
    this.#now = opts.now ?? Date.now;
  }

  /** 給測試用：組出要送給 Discord 的 payload */
  static payload(alert: Alert, at: Date = new Date()) {
    return {
      username: "Dev-in.tw",
      allowed_mentions: { parse: [] as string[] },
      embeds: [
        {
          title: alert.title.slice(0, 256),
          description: alert.description.slice(0, 4000),
          color: COLORS[alert.severity],
          timestamp: at.toISOString(),
          footer: { text: `dev-in.tw · ${alert.severity}` },
          ...(alert.url ? { url: alert.url } : {}),
          ...(alert.fields
            ? {
                fields: alert.fields.slice(0, 25).map((f) => ({
                  name: f.name.slice(0, 256),
                  value: f.value.slice(0, 1024) || "-",
                  inline: f.inline ?? false,
                })),
              }
            : {}),
        },
      ],
    };
  }

  notify(alert: Alert): void {
    const now = this.#now();
    const last = this.#lastSent.get(alert.key);
    if (last !== undefined && now - last < this.#throttleMs) return;
    this.#lastSent.set(alert.key, now);
    this.sent.push(alert);
    this.#logger.warn({ alert: alert.key, severity: alert.severity }, alert.title);
    if (!this.#url) return;
    const url = this.#url;
    void fetchWithTimeout(this.#fetch, url, {
      method: "POST",
      timeoutMs: 5000,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(DiscordNotifier.payload(alert, new Date(now))),
    })
      .then((res) => {
        if (!res.ok) this.#logger.warn({ status: res.status }, "discord webhook rejected");
      })
      .catch((error: unknown) => this.#logger.warn({ err: error }, "discord webhook failed"));
  }
}
