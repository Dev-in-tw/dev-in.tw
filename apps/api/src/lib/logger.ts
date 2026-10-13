import { pino } from "pino";

export type Logger = pino.Logger;

/**
 * pino JSON 輸出到 stdout（wide events，PLAN §3.11）。redact 是最後一道防線：
 * 程式本來就不應該把 cookie、token、OAuth code、完整 email 放進 log。
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "dit-api" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: [
        "cookie",
        "*.cookie",
        "token",
        "*.token",
        "authorization",
        "*.authorization",
        "email",
        "*.email",
        "accessToken",
        "*.accessToken",
      ],
      censor: "[redacted]",
    },
  });
}

export const silentLogger: Logger = pino({ level: "silent" });
