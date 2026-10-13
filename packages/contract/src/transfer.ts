import { z } from "zod";
import { GithubLogin, IsoDateTime, PublicUser, SubdomainName, Uuid } from "./primitives.ts";

export const TransferStatus = z.enum(["pending", "accepted", "declined", "cancelled", "expired"]);
export type TransferStatus = z.infer<typeof TransferStatus>;
export const Transfer = z.object({
  id: Uuid,
  subdomain: SubdomainName,
  from: PublicUser,
  to: PublicUser,
  status: TransferStatus,
  keepRecords: z.boolean(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
});
export type Transfer = z.infer<typeof Transfer>;
export const CreateTransferBody = z.object({
  toGithubLogin: GithubLogin,
  keepRecords: z.boolean().default(true),
});
export type CreateTransferBody = z.infer<typeof CreateTransferBody>;
export const TransferList = z.object({ incoming: z.array(Transfer), outgoing: z.array(Transfer) });
export type TransferList = z.infer<typeof TransferList>;
