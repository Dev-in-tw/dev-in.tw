import { z } from "zod";
import { IsoDateTime, Usage, Uuid } from "./primitives.ts";

export const Role = z.enum(["user", "admin"]);
export type Role = z.infer<typeof Role>;
export const UserStatus = z.enum(["active", "suspended"]);
export type UserStatus = z.infer<typeof UserStatus>;

export const Me = z.object({
  id: Uuid,
  githubId: z.int(),
  githubLogin: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.url(),
  email: z.email().nullable(),
  role: Role,
  status: UserStatus,
  quota: z.object({ subdomains: Usage, recordsPerSubdomain: z.int() }),
  incomingTransfers: z.int().min(0),
  createdAt: IsoDateTime,
});
export type Me = z.infer<typeof Me>;

export const UpdateMeBody = z
  .object({ displayName: z.string().trim().max(50).nullable() })
  .partial();
export type UpdateMeBody = z.infer<typeof UpdateMeBody>;
export const DeleteMeBody = z.object({ confirm: z.string() }); // 必須等於 githubLogin
export type DeleteMeBody = z.infer<typeof DeleteMeBody>;

export const Session = z.object({
  id: z.string(), // 對外的 opaque id（非 token hash）
  current: z.boolean(),
  userAgent: z.string().nullable(),
  ipApprox: z.string().nullable(), // 例如 "203.0.113.x"
  createdAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
});
export type Session = z.infer<typeof Session>;
