import { z } from "zod";
import { IsoDateTime, SubdomainName, Uuid } from "./primitives.ts";

export const ReportCategory = z.enum([
  "phishing",
  "malware",
  "spam",
  "illegal",
  "impersonation",
  "other",
]);
export type ReportCategory = z.infer<typeof ReportCategory>;
export const ReportStatus = z.enum(["open", "actioned", "dismissed"]);
export type ReportStatus = z.infer<typeof ReportStatus>;
export const CreateReportBody = z.object({
  subdomain: SubdomainName,
  category: ReportCategory,
  details: z.string().min(10).max(2000),
  contactEmail: z.email().optional(),
  turnstileToken: z.string().min(1),
});
export type CreateReportBody = z.infer<typeof CreateReportBody>;
export const ReportReceipt = z.object({ id: Uuid, createdAt: IsoDateTime });
export type ReportReceipt = z.infer<typeof ReportReceipt>;
