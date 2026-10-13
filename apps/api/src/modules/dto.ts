import type {
  AdminSubdomain,
  AdminUser,
  DnsRecord,
  PublicUser,
  RecordInput,
  Subdomain,
} from "@dit/contract";
import type { RecordRow, SubdomainRow, UserRow } from "../db/schema.ts";
import { fqdnOf } from "../sync/mapper.ts";

export const iso = (d: Date): string => d.toISOString();
export const isoOrNull = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;

export function publicUser(
  u: Pick<UserRow, "githubLogin" | "displayName" | "avatarUrl">,
): PublicUser {
  return { githubLogin: u.githubLogin, displayName: u.displayName, avatarUrl: u.avatarUrl };
}

/** DB 的 data 欄位（jsonb）→ 合約的 RecordInput */
export function recordInputOf(r: Pick<RecordRow, "name" | "type" | "ttl" | "data">): RecordInput {
  const d = r.data;
  const common = { name: r.name, ttl: r.ttl };
  switch (r.type) {
    case "A":
      return { type: "A", ...common, address: String(d.address) };
    case "AAAA":
      return { type: "AAAA", ...common, address: String(d.address) };
    case "CNAME":
      return { type: "CNAME", ...common, target: String(d.target) };
    case "TXT":
      return { type: "TXT", ...common, value: String(d.value) };
    case "MX":
      return { type: "MX", ...common, priority: Number(d.priority), exchange: String(d.exchange) };
    case "SRV":
      return {
        type: "SRV",
        ...common,
        priority: Number(d.priority),
        weight: Number(d.weight),
        port: Number(d.port),
        target: String(d.target),
      };
    case "CAA":
      return {
        type: "CAA",
        ...common,
        flags: Number(d.flags) as 0 | 128,
        tag: String(d.tag) as "issue" | "issuewild" | "iodef",
        value: String(d.value),
      };
  }
}

/** RecordInput → DB 的 data 欄位 */
export function recordDataOf(input: RecordInput): Record<string, string | number> {
  const { type: _t, name: _n, ttl: _ttl, ...data } = input;
  return data as Record<string, string | number>;
}

export function recordDto(r: RecordRow, subdomain: string, root: string): DnsRecord {
  return {
    ...recordInputOf(r),
    id: r.id,
    fqdn: fqdnOf(r.name, subdomain, root),
    version: r.version,
    syncStatus: r.syncStatus,
    syncError: r.syncErrorCode
      ? { code: r.syncErrorCode, message: r.syncErrorMessage ?? "" }
      : null,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function subdomainDto(
  s: SubdomainRow,
  extra: {
    root: string;
    recordsUsed: number;
    recordsLimit: number;
    pendingTransferId: string | null;
  },
): Subdomain {
  return {
    name: s.name,
    fqdn: `${s.name}.${extra.root}`,
    status: s.status,
    description: s.description,
    showInDirectory: s.showInDirectory,
    records: { used: extra.recordsUsed, limit: extra.recordsLimit },
    reviewReasons: s.reviewReasons,
    suspendedReason: s.suspendedReason,
    pendingTransferId: extra.pendingTransferId,
    createdAt: iso(s.createdAt),
    activatedAt: isoOrNull(s.activatedAt),
    updatedAt: iso(s.updatedAt),
  };
}

export function adminSubdomainDto(base: Subdomain, owner: UserRow): AdminSubdomain {
  return {
    ...base,
    owner: { ...publicUser(owner), id: owner.id, githubCreatedAt: iso(owner.githubCreatedAt) },
  };
}

export function adminUserDto(u: UserRow, subdomainCount: number): AdminUser {
  return {
    id: u.id,
    githubId: u.githubId,
    githubLogin: u.githubLogin,
    avatarUrl: u.avatarUrl,
    email: u.email,
    role: u.role,
    status: u.status,
    suspendedReason: u.suspendedReason,
    githubCreatedAt: iso(u.githubCreatedAt),
    subdomainCount,
    quotaOverride:
      u.quotaSubdomains === null && u.quotaRecords === null
        ? null
        : { subdomains: u.quotaSubdomains, recordsPerSubdomain: u.quotaRecords },
    createdAt: iso(u.createdAt),
    lastLoginAt: iso(u.lastLoginAt),
  };
}

/** 以 id 為游標的分頁（UUIDv7 依時間排序） */
export function encodeCursor(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
export function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const value = Buffer.from(cursor, "base64url").toString("utf8");
    return value.length > 0 && value.length <= 200 ? value : null;
  } catch {
    return null;
  }
}
export function pageOf<T>(rows: T[], limit: number, cursorOf: (row: T) => string) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null };
}
