import { pino } from "pino";

export type Logger = pino.Logger;

/**
 * redact 是最後一道防線：程式本來就不應該把 cookie、token、OAuth code、email 或原始 IP 放進 log
 * （PLAN §3.11、隱私權政策第 2 條：日誌只記錄加鹽雜湊後的 IP）。新增欄位時優先用 `ip_hash`。
 */
export const REDACT_PATHS = [
  "cookie",
  "*.cookie",
  "token",
  "*.token",
  "authorization",
  "*.authorization",
  "code",
  "email",
  "*.email",
  "contactEmail",
  "*.contactEmail",
  "contact_email",
  "*.contact_email",
  "accessToken",
  "*.accessToken",
  "ip",
  "*.ip",
  "clientIp",
  "*.clientIp",
  "client_ip",
  "*.client_ip",
  "remoteip",
  "*.remoteip",
  "userAgent",
  "*.userAgent",
];

/** pino JSON 輸出到 stdout（wide events，PLAN §3.11）。測試可以傳入 destination 檢查輸出。 */
export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service: "dit-api" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const silentLogger: Logger = pino({ level: "silent" });
