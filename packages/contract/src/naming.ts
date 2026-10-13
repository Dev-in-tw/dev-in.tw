import { z } from "zod";
import { SubdomainLabel } from "./primitives.ts";

export const AvailabilityStatus = z.enum([
  "available",
  "review",
  "taken",
  "reserved",
  "invalid",
  "cooldown",
  "capacity_full",
]);
export type AvailabilityStatus = z.infer<typeof AvailabilityStatus>;
export const Availability = z.object({
  name: z.string(),
  fqdn: z.string(),
  status: AvailabilityStatus,
  reason: z.string().optional(), // 繁中說明
  reviewReasons: z.array(z.string()).optional(), // status=review 時
  suggestions: z.array(SubdomainLabel).max(5),
});
export type Availability = z.infer<typeof Availability>;
