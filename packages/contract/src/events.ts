import { z } from "zod";
import { SyncEta, SyncStatus } from "./dns.ts";
import { IsoDateTime, SubdomainName, Uuid } from "./primitives.ts";
import { SubdomainStatus } from "./subdomain.ts";
import { TransferStatus } from "./transfer.ts";

/** SSE：event 名稱 = type，data = JSON */
export const ServerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("record.sync"),
    subdomain: SubdomainName,
    recordId: Uuid,
    version: z.int(),
    syncStatus: SyncStatus,
    syncError: z.object({ code: z.string(), message: z.string() }).nullable(),
    syncEta: SyncEta.optional(),
  }),
  z.object({ type: z.literal("record.deleted"), subdomain: SubdomainName, recordId: Uuid }),
  z.object({
    type: z.literal("subdomain.status"),
    subdomain: SubdomainName,
    status: SubdomainStatus,
  }),
  z.object({ type: z.literal("transfer.updated"), transferId: Uuid, status: TransferStatus }),
  z.object({ type: z.literal("ping"), at: IsoDateTime }), // 每 25 秒一次，避免被 Traefik 的 idle timeout 切斷
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
export type ServerEventType = ServerEvent["type"];
