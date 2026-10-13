import { z } from "zod";

export const Uuid = z.uuid();
export const IsoDateTime = z.iso.datetime({ offset: true });

/** 使用者可自行註冊的 label：3–32 字元、小寫英數與連字號、頭尾不可為連字號、不可含 "--"（同時擋掉 xn--） */
export const SUBDOMAIN_LABEL_RE = /^(?!.*--)[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export const SubdomainLabel = z.string().regex(SUBDOMAIN_LABEL_RE);
export type SubdomainLabel = z.infer<typeof SubdomainLabel>;
/** 任何已存在的子網域名稱（含日後由管理員指派的 1–2 字元 premium 名稱）；用於路徑參數與回應 */
export const SUBDOMAIN_NAME_RE = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const SubdomainName = z.string().regex(SUBDOMAIN_NAME_RE);
export type SubdomainName = z.infer<typeof SubdomainName>;

/** 紀錄名稱（相對於子網域）："@" 或 1–3 個 label，label 可以底線開頭 */
const LABEL = "_?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
export const RECORD_NAME_RE = new RegExp(`^(?:@|${LABEL}(?:\\.${LABEL}){0,2})$`);
export const RecordName = z.string().regex(RECORD_NAME_RE);
export type RecordName = z.infer<typeof RecordName>;

/** 目標主機名（CNAME、MX、SRV），不含結尾的點 */
export const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const Hostname = z.string().regex(HOSTNAME_RE);
export type Hostname = z.infer<typeof Hostname>;

export const GithubLogin = z.string().regex(/^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/);
export type GithubLogin = z.infer<typeof GithubLogin>;

export const PageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof PageQuery>;
export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const Usage = z.object({ used: z.int().min(0), limit: z.int().min(0) });
export type Usage = z.infer<typeof Usage>;

export const PublicUser = z.object({
  githubLogin: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.url(),
});
export type PublicUser = z.infer<typeof PublicUser>;
