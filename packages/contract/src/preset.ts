import { z } from "zod";
import { DnsRecord, RecordInput } from "./dns.ts";
import { RecordName } from "./primitives.ts";

export const PresetId = z.enum([
  "github-pages",
  "vercel",
  "netlify",
  "cloudflare-pages",
  "zeabur",
  "render",
  "fly",
  "bluesky",
  "improvmx",
  "google-site-verification",
]);
export type PresetId = z.infer<typeof PresetId>;
export const Preset = z.object({
  id: PresetId,
  title: z.string(),
  description: z.string(),
  docsSlug: z.string(),
  available: z.boolean(), // P1 的 preset 在後端尚未支援時為 false
  params: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      placeholder: z.string(),
      required: z.boolean(),
      pattern: z.string().optional(), // 前端即時驗證用的 regex 原始碼
      defaultFrom: z.enum(["githubLogin"]).optional(),
    }),
  ),
});
export type Preset = z.infer<typeof Preset>;
export const PresetBody = z.object({
  recordName: RecordName.default("@"),
  params: z.record(z.string(), z.string().max(255)),
});
export type PresetBody = z.infer<typeof PresetBody>;
export const PresetPlan = z.object({
  creates: z.array(RecordInput),
  deletes: z.array(DnsRecord),
  warnings: z.array(z.string()),
});
export type PresetPlan = z.infer<typeof PresetPlan>;
