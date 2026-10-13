import { z } from "zod";

/**
 * 環境變數驗證（缺值或格式錯誤時直接啟動失敗）。
 * WP0 只放啟動空殼需要的欄位；完整清單見 docs/PLAN.md §3.13，由 WP-A 補齊。
 */
const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  HOST: z.string().default("0.0.0.0"),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
