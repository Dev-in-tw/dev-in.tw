/**
 * Mock API 的 in-memory 狀態。以合約 fixtures 為種子，保持確定性（固定 id 與時間），
 * 讓 e2e 與截圖可以重現。`POST /api/__mock/reset` 會呼叫 `resetState()`。
 */
import type {
  AdminReport,
  AdminSettings,
  AuditEvent,
  DnsRecord,
  EndpointName,
  PublicUser,
  ReservedName,
  Role,
  Subdomain,
  Transfer,
  UserStatus,
} from "@dit/contract";
import {
  ids,
  ROOT_DOMAIN,
  records as recordFixtures,
  responses,
  subdomains as subdomainFixtures,
  users as userFixtures,
} from "@dit/contract/fixtures";

export interface MockUser {
  id: string;
  githubId: number;
  githubLogin: string;
  displayName: string | null;
  email: string | null;
  role: Role;
  status: UserStatus;
  suspendedReason: string | null;
  githubCreatedAt: string;
  createdAt: string;
  lastLoginAt: string;
  quotaOverride: { subdomains: number | null; recordsPerSubdomain: number | null } | null;
}

export interface MockSession {
  id: string;
  token: string;
  userId: string;
  userAgent: string | null;
  ipApprox: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export type MockSubdomain = Subdomain & { ownerId: string };
export type MockTransfer = Omit<Transfer, "from" | "to"> & { fromId: string; toId: string };
export type MockAudit = AuditEvent & { actorId: string | null; subdomain: string | null };

export interface MockConfig {
  /** 這些端點回 501 NOT_IMPLEMENTED，用來測試 P1 的優雅降級 */
  notImplemented: EndpointName[];
  /** zone 容量已滿 */
  capacityFull: boolean;
  /** 紀錄 pending → synced 的延遲 */
  syncDelayMs: number;
}

export const LIMITS = { subdomainsPerUser: 2, recordsPerSubdomain: 10, zoneRecords: 1000 };

const T_OLD = "2026-10-01T08:00:00.000Z";
const T_NOW = "2026-10-14T08:00:00.000Z";

/** 公開成員（opt-in）：讓 Landing 的跑馬燈、成員牆與台灣點陣地圖有內容。名字取自台灣地名與小吃。 */
const MEMBERS: [name: string, login: string, description: string][] = [
  ["taipei-bytes", "taipei-bytes", "在捷運上寫 code 的前端工程師"],
  ["boba-stack", "boba-stack", "全端開發，珍奶半糖少冰"],
  ["yilan-rain", "yilan-rain", "宜蘭人，喜歡下雨天跟 Rust"],
  ["tainan-snack", "tainan-snack", "台南小吃地圖，用 Astro 做的"],
  ["kaohsiung-port", "kaohsiung-port", "港都的 DevOps 筆記"],
  ["hsinchu-hacker", "hsinchu-hacker", "竹科下班後的 side project"],
  ["penghu-wind", "penghu-wind", "風很大的部落格"],
  ["kinmen-moon", "kinmen-moon", "金門出身的 iOS 開發者"],
  ["matsu-tears", "matsu-tears", "藍眼淚季節限定的攝影集"],
  ["lanyu-wave", "lanyu-wave", "飛魚季前後更新的旅行日誌"],
  ["formosa-labs", "formosa-labs", "開源工具與小實驗"],
  ["mochi-dev", "mochi-dev", "QQ 的 UI 元件庫"],
  ["nightowl", "nightowl", "凌晨三點的 commit 都在這"],
  ["cyber-otter", "cyber-otter", "資安與 CTF writeup"],
  ["hualien-trail", "hualien-trail", "步道紀錄與 GPX 檔"],
  ["chiayi-turkey", "chiayi-turkey", "火雞肉飯評比 API"],
];

export interface State {
  users: MockUser[];
  sessions: MockSession[];
  subdomains: MockSubdomain[];
  records: Map<string, DnsRecord[]>;
  transfers: MockTransfer[];
  reports: AdminReport[];
  reserved: ReservedName[];
  holds: Map<string, string>;
  audit: MockAudit[];
  settings: AdminSettings;
  config: MockConfig;
  idempotency: Map<string, { hash: string; status: number; body: unknown }>;
  seq: number;
}

function user(
  id: string,
  githubId: number,
  login: string,
  extra: Partial<MockUser> = {},
): MockUser {
  return {
    id,
    githubId,
    githubLogin: login,
    displayName: null,
    email: `${login.toLowerCase()}@example.com`,
    role: "user",
    status: "active",
    suspendedReason: null,
    githubCreatedAt: "2019-03-02T10:00:00.000Z",
    createdAt: T_OLD,
    lastLoginAt: T_NOW,
    quotaOverride: null,
    ...extra,
  };
}

const uuid = (prefix: string, n: number) =>
  `${prefix}-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function seed(): State {
  const users: MockUser[] = [
    user(ids.alice, 1234567, "alice", { displayName: userFixtures.alice.displayName }),
    user(ids.bob, 7654321, "bob-dev", { githubCreatedAt: "2026-10-10T00:00:00.000Z" }),
    user(ids.admin, 51485352, "HACO8888", {
      displayName: "Haco",
      email: null,
      role: "admin",
      quotaOverride: { subdomains: 5, recordsPerSubdomain: null },
    }),
    user(uuid("0199e2a1", 0x5bad), 9999001, "spam-bot-42", {
      status: "suspended",
      suspendedReason: "多次架設釣魚網站",
      githubCreatedAt: "2026-10-12T00:00:00.000Z",
    }),
  ];

  const subdomains: MockSubdomain[] = [
    { ...subdomainFixtures.active, ownerId: ids.alice },
    { ...subdomainFixtures.pending_review, ownerId: ids.bob },
    {
      ...subdomainFixtures.suspended,
      ownerId: uuid("0199e2a1", 0x5bad),
    },
  ];

  MEMBERS.forEach(([name, login, description], i) => {
    const id = uuid("0199e2a6", i + 1);
    users.push(user(id, 2_000_000 + i, login, { createdAt: T_OLD }));
    const day = String(13 - (i % 12)).padStart(2, "0");
    const since = `2026-10-${day}T0${i % 10}:00:00.000Z`;
    subdomains.push({
      name,
      fqdn: `${name}.${ROOT_DOMAIN}`,
      status: "active",
      description,
      showInDirectory: true,
      records: { used: 2, limit: LIMITS.recordsPerSubdomain },
      reviewReasons: [],
      suspendedReason: null,
      pendingTransferId: null,
      createdAt: since,
      activatedAt: since,
      updatedAt: since,
      ownerId: id,
    });
  });

  // alice 的紀錄：只放 MVP 開放的類型，涵蓋 synced、pending、error 三種狀態
  const aliceRecords: DnsRecord[] = [
    recordFixtures.A,
    recordFixtures.AAAA,
    recordFixtures.CNAME,
    recordFixtures.TXT,
    recordFixtures.MX,
  ].map((r) => ({ ...r }));
  const records = new Map<string, DnsRecord[]>([["alice", aliceRecords]]);
  for (const s of subdomains) {
    if (!records.has(s.name)) records.set(s.name, []);
  }
  const alice = subdomains[0];
  if (alice) alice.records = { used: aliceRecords.length, limit: LIMITS.recordsPerSubdomain };

  const transfers: MockTransfer[] = [];

  const reports: AdminReport[] = responses.adminListReports.items.map((r) => ({ ...r }));
  const reserved: ReservedName[] = responses.adminListReserved.items.map((r) => ({ ...r }));

  const audit: MockAudit[] = responses.listMyActivity.items.map((e) => ({
    ...e,
    actor: e.actor ? { ...e.actor } : null,
    metadata: { ...e.metadata },
    actorId: e.actorType === "user" ? ids.alice : null,
    subdomain: "alice",
  }));

  return {
    users,
    sessions: [],
    subdomains,
    records,
    transfers,
    reports,
    reserved,
    holds: new Map([["old-blog", "2026-11-13T08:00:00.000Z"]]),
    audit,
    settings: { registrationOpen: true, reviewMode: "risk" },
    config: { notImplemented: [], capacityFull: false, syncDelayMs: 1200 },
    idempotency: new Map(),
    seq: 0,
  };
}

export let state: State = seed();

export function resetState(): void {
  state = seed();
}

/** 確定性的 UUIDv7 形狀 id */
export function nextId(kind: "record" | "transfer" | "report" | "audit" | "user" | "session") {
  state.seq += 1;
  const tag = { record: "b", transfer: "c", report: "d", audit: "e", user: "f", session: "a" }[
    kind
  ];
  return `0199e2c${tag}-${(state.seq & 0xffff).toString(16).padStart(4, "0")}-7000-8000-${state.seq
    .toString(16)
    .padStart(12, "0")}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function publicUser(u: MockUser, origin: string): PublicUser {
  return {
    githubLogin: u.githubLogin,
    displayName: u.displayName,
    avatarUrl: avatarUrl(u.githubLogin, origin),
  };
}

/** 不連到真實的 GitHub 頭像（避免 e2e 依賴外網，也不會顯示真實人物）：mock 自己產生 SVG */
export function avatarUrl(login: string, origin: string): string {
  return `${origin}/api/__mock/avatar/${encodeURIComponent(login)}`;
}

export function findUser(id: string): MockUser | undefined {
  return state.users.find((u) => u.id === id);
}

export function findUserByLogin(login: string): MockUser | undefined {
  const lower = login.toLowerCase();
  return state.users.find((u) => u.githubLogin.toLowerCase() === lower);
}

export function subdomainQuota(u: MockUser): number {
  return u.quotaOverride?.subdomains ?? LIMITS.subdomainsPerUser;
}

export function recordQuota(u: MockUser): number {
  return u.quotaOverride?.recordsPerSubdomain ?? LIMITS.recordsPerSubdomain;
}

export function zoneUsed(): number {
  let n = 6; // 系統紀錄
  for (const list of state.records.values()) n += list.length;
  // 讓儀表看起來像真實的 zone：成員各自另有約兩筆紀錄
  return n + 330;
}
