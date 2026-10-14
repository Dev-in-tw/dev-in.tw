/**
 * 合約 fixtures：每個有 JSON 回應的端點至少一個合法範例，另外依狀態列出變化形。
 *
 * - 給 WP-B 的 mock server 與元件測試、WP-A 的合約一致性測試共用。
 * - 只能從 `@dit/contract/fixtures` 匯入，不會進到正式的 client bundle。
 * - 數值依 PLAN.md §7：每人 2 個子網域、每個子網域 10 筆紀錄、zone 上限 1,000 筆。
 */
import type {
  AdminSubdomain,
  AdminUser,
  AuditEvent,
  Availability,
  AvailabilityStatus,
  DirectoryEntry,
  DnsRecord,
  EndpointName,
  Endpoints,
  Me,
  Preset,
  Problem,
  PublicUser,
  RecordType,
  RequestOf,
  ResponseOf,
  ServerEvent,
  Subdomain,
  SubdomainStatus,
  SyncStatus,
  Transfer,
  UserDataExport,
} from "./index.ts";
import { CURRENT_LEGAL_VERSIONS, DATA_EXPORT_FORMAT, problemType } from "./index.ts";

export const ROOT_DOMAIN = "dev-in.tw";

/** 固定的 UUIDv7 形狀 id（RFC 9562：第 13 碼為 7、variant 為 8–b） */
export const ids = {
  alice: "0199e2a1-7c00-7a00-8000-00000000a11c",
  bob: "0199e2a1-7c00-7a00-8000-000000000b0b",
  admin: "0199e2a1-7c00-7a00-8000-0000000ad111",
  recordA: "0199e2a2-1000-7000-8000-000000000001",
  recordAAAA: "0199e2a2-1000-7000-8000-000000000002",
  recordCNAME: "0199e2a2-1000-7000-8000-000000000003",
  recordTXT: "0199e2a2-1000-7000-8000-000000000004",
  recordMX: "0199e2a2-1000-7000-8000-000000000005",
  recordSRV: "0199e2a2-1000-7000-8000-000000000006",
  recordCAA: "0199e2a2-1000-7000-8000-000000000007",
  recordApexCNAME: "0199e2a2-1000-7000-8000-000000000008",
  transfer: "0199e2a3-2000-7000-9000-000000000001",
  report: "0199e2a4-3000-7000-a000-000000000001",
  audit1: "0199e2a5-4000-7000-b000-000000000001",
  audit2: "0199e2a5-4000-7000-b000-000000000002",
} as const;

const T0 = "2026-10-01T08:00:00.000Z";
const T1 = "2026-10-14T08:00:00.000Z";
const T2 = "2026-10-14T08:00:01.200+08:00";

export const users = {
  alice: {
    githubLogin: "alice",
    displayName: "Alice Chen",
    avatarUrl: "https://avatars.githubusercontent.com/u/1234567?v=4",
  },
  bob: {
    githubLogin: "bob-dev",
    displayName: null,
    avatarUrl: "https://avatars.githubusercontent.com/u/7654321?v=4",
  },
  admin: {
    githubLogin: "HACO8888",
    displayName: "Haco",
    avatarUrl: "https://avatars.githubusercontent.com/u/51485352?v=4",
  },
} as const satisfies Record<string, PublicUser>;

const fqdn = (name: string) =>
  name === "@" ? `alice.${ROOT_DOMAIN}` : `${name}.alice.${ROOT_DOMAIN}`;

const recordMeta = (id: string, name: string, syncStatus: SyncStatus, version = 1) => ({
  id,
  fqdn: fqdn(name),
  version,
  syncStatus,
  syncError: null,
  createdAt: T0,
  updatedAt: T1,
});

/** alice.dev-in.tw 的紀錄：每種類型一筆，涵蓋四種同步狀態 */
export const records = {
  A: {
    type: "A",
    name: "@",
    ttl: 1,
    address: "185.199.108.153",
    ...recordMeta(ids.recordA, "@", "synced"),
  },
  AAAA: {
    type: "AAAA",
    name: "@",
    ttl: 1,
    address: "2606:50c0:8000::153",
    ...recordMeta(ids.recordAAAA, "@", "synced"),
  },
  CNAME: {
    type: "CNAME",
    name: "www",
    ttl: 300,
    target: "alice.github.io",
    ...recordMeta(ids.recordCNAME, "www", "pending", 2),
  },
  TXT: {
    type: "TXT",
    name: "_github-pages-challenge-alice",
    ttl: 3600,
    value: "5f2c1e9a7b3d4c6e8f0a1b2c3d4e5f",
    ...recordMeta(ids.recordTXT, "_github-pages-challenge-alice", "synced"),
  },
  MX: {
    type: "MX",
    name: "@",
    ttl: 3600,
    priority: 10,
    exchange: "mx1.improvmx.com",
    ...recordMeta(ids.recordMX, "@", "error"),
    syncError: { code: "UPSTREAM_DNS_ERROR", message: "DNS 服務暫時無法寫入，系統會自動重試" },
  },
  SRV: {
    type: "SRV",
    name: "_minecraft._tcp",
    ttl: 300,
    priority: 0,
    weight: 5,
    port: 25565,
    target: "mc.example.net",
    ...recordMeta(ids.recordSRV, "_minecraft._tcp", "deleting"),
  },
  CAA: {
    type: "CAA",
    name: "@",
    ttl: 86400,
    flags: 0,
    tag: "issue",
    value: "letsencrypt.org",
    ...recordMeta(ids.recordCAA, "@", "synced"),
  },
} as const satisfies Record<RecordType, DnsRecord>;

const subdomainBase = {
  name: "alice",
  fqdn: `alice.${ROOT_DOMAIN}`,
  status: "active",
  description: "Alice 的個人網站與部落格",
  showInDirectory: true,
  records: { used: 7, limit: 10 },
  reviewReasons: [],
  suspendedReason: null,
  pendingTransferId: null,
  createdAt: T0,
  activatedAt: T0,
  updatedAt: T1,
} satisfies Subdomain;

export const subdomains = {
  active: subdomainBase,
  pending_review: {
    ...subdomainBase,
    name: "paypa1-shop",
    fqdn: `paypa1-shop.${ROOT_DOMAIN}`,
    status: "pending_review",
    showInDirectory: false,
    records: { used: 0, limit: 10 },
    reviewReasons: ["account_too_new", "confusable:paypal"],
    activatedAt: null,
  },
  suspended: {
    ...subdomainBase,
    name: "free-gift",
    fqdn: `free-gift.${ROOT_DOMAIN}`,
    status: "suspended",
    showInDirectory: false,
    suspendedReason: "檢舉成立：釣魚網站",
  },
  releasing: {
    ...subdomainBase,
    name: "old-blog",
    fqdn: `old-blog.${ROOT_DOMAIN}`,
    status: "releasing",
    showInDirectory: false,
    pendingTransferId: null,
  },
} as const satisfies { [S in SubdomainStatus]: Subdomain & { status: S } };

export const availability = {
  available: { name: "alice", fqdn: `alice.${ROOT_DOMAIN}`, status: "available", suggestions: [] },
  review: {
    name: "paypa1-shop",
    fqdn: `paypa1-shop.${ROOT_DOMAIN}`,
    status: "review",
    reason: "名稱和知名品牌相似，送出後需要人工審核",
    reviewReasons: ["confusable:paypal"],
    suggestions: [],
  },
  taken: {
    name: "bob",
    fqdn: `bob.${ROOT_DOMAIN}`,
    status: "taken",
    reason: "這個名稱已經有人使用",
    suggestions: ["bob-dev", "bobtw", "bob-dev-tw"],
  },
  reserved: {
    name: "admin",
    fqdn: `admin.${ROOT_DOMAIN}`,
    status: "reserved",
    reason: "這是系統保留的名稱",
    suggestions: ["admin-dev", "admintw"],
  },
  invalid: {
    name: "xn--abc",
    fqdn: `xn--abc.${ROOT_DOMAIN}`,
    status: "invalid",
    reason: "名稱不可包含連續的連字號（--）",
    suggestions: [],
  },
  cooldown: {
    name: "old-blog",
    fqdn: `old-blog.${ROOT_DOMAIN}`,
    status: "cooldown",
    reason: "這個名稱剛被釋出，冷卻期結束後才能申請",
    suggestions: ["old-blog-dev"],
  },
  capacity_full: {
    name: "carol",
    fqdn: `carol.${ROOT_DOMAIN}`,
    status: "capacity_full",
    reason: "目前名額已滿，請稍後再試",
    suggestions: [],
  },
} as const satisfies { [S in AvailabilityStatus]: Availability & { status: S } };

const me = {
  id: ids.alice,
  githubId: 1234567,
  githubLogin: "alice",
  displayName: "Alice Chen",
  avatarUrl: users.alice.avatarUrl,
  email: "alice@example.com",
  role: "user",
  status: "active",
  quota: { subdomains: { used: 1, limit: 2 }, recordsPerSubdomain: 10 },
  incomingTransfers: 0,
  createdAt: T0,
  consent: { ...CURRENT_LEGAL_VERSIONS, acceptedAt: T0 },
  consentRequired: false,
} as const satisfies Me;

const transfer = {
  id: ids.transfer,
  subdomain: "alice",
  from: users.alice,
  to: users.bob,
  status: "pending",
  keepRecords: true,
  createdAt: T1,
  expiresAt: "2026-10-21T08:00:00.000Z",
  resolvedAt: null,
} as const satisfies Transfer;

const directoryEntry = {
  name: "alice",
  fqdn: `alice.${ROOT_DOMAIN}`,
  description: "Alice 的個人網站與部落格",
  owner: users.alice,
  since: T0,
} as const satisfies DirectoryEntry;

const auditEvents = [
  {
    id: ids.audit2,
    action: "record.create",
    actor: users.alice,
    actorType: "user",
    target: { type: "record", id: ids.recordCNAME, label: `www.alice.${ROOT_DOMAIN}` },
    metadata: { type: "CNAME", target: "alice.github.io" },
    createdAt: T1,
  },
  {
    id: ids.audit1,
    action: "record.sync_failed",
    actor: null,
    actorType: "system",
    target: { type: "record", id: ids.recordMX, label: `alice.${ROOT_DOMAIN}` },
    metadata: { code: "UPSTREAM_DNS_ERROR", attempt: 3 },
    createdAt: T0,
  },
] as const satisfies AuditEvent[];

const adminUser = {
  id: ids.alice,
  githubId: 1234567,
  githubLogin: "alice",
  avatarUrl: users.alice.avatarUrl,
  email: "alice@example.com",
  role: "user",
  status: "active",
  suspendedReason: null,
  githubCreatedAt: "2019-03-02T10:00:00.000Z",
  subdomainCount: 1,
  quotaOverride: null,
  createdAt: T0,
  lastLoginAt: T1,
} as const satisfies AdminUser;

const adminSubdomain = (sub: Subdomain): AdminSubdomain => ({
  ...sub,
  owner: { ...users.alice, id: ids.alice, githubCreatedAt: "2019-03-02T10:00:00.000Z" },
});

/** 與 packages/dns 的 PRESETS 相同內容（packages/dns 有測試比對 id 集合） */
export const presets = [
  {
    id: "github-pages",
    title: "GitHub Pages",
    description: "把子網域指向你的 GitHub Pages 網站",
    docsSlug: "github-pages",
    available: true,
    params: [
      {
        key: "githubUser",
        label: "GitHub 使用者或組織",
        placeholder: "octocat",
        required: true,
        pattern: "^[A-Za-z\\d](?:[A-Za-z\\d]|-(?=[A-Za-z\\d])){0,38}$",
        defaultFrom: "githubLogin",
      },
      {
        key: "verifyToken",
        label: "網域驗證碼（選填）",
        placeholder: "GitHub 提供的 TXT 值",
        required: false,
      },
    ],
  },
  {
    id: "vercel",
    title: "Vercel",
    description: "把子網域指向 Vercel 專案",
    docsSlug: "vercel",
    available: true,
    params: [
      { key: "target", label: "CNAME 目標", placeholder: "cname.vercel-dns.com", required: false },
      {
        key: "verifyTxt",
        label: "驗證 TXT（選填）",
        placeholder: "vc-domain-verify=…",
        required: false,
      },
    ],
  },
  {
    id: "netlify",
    title: "Netlify",
    description: "把子網域指向 Netlify 網站",
    docsSlug: "netlify",
    available: true,
    params: [
      {
        key: "site",
        label: "Netlify 網站名稱",
        placeholder: "my-site",
        required: true,
        pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
      },
    ],
  },
  {
    id: "cloudflare-pages",
    title: "Cloudflare Pages",
    description: "把子網域指向 Cloudflare Pages 專案",
    docsSlug: "cloudflare-pages",
    available: true,
    params: [
      {
        key: "project",
        label: "Pages 專案名稱",
        placeholder: "my-project",
        required: true,
        pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
      },
    ],
  },
  {
    id: "bluesky",
    title: "Bluesky handle",
    description: "用子網域當作你的 Bluesky handle",
    docsSlug: "bluesky",
    available: false,
    params: [
      {
        key: "did",
        label: "DID",
        placeholder: "did:plc:…",
        required: true,
        pattern: "^did:[a-z]+:[A-Za-z0-9._:%-]+$",
      },
    ],
  },
] as const satisfies Preset[];

/** 每個有 JSON 回應的端點一個合法範例 */
type JsonEndpoint = {
  [N in EndpointName]: Endpoints[N]["response"] extends null ? never : N;
}[EndpointName];

/** GET /me/export 的範例（alice） */
const dataExport = {
  format: DATA_EXPORT_FORMAT,
  generatedAt: T1,
  account: {
    id: ids.alice,
    githubId: 1234567,
    githubLogin: "alice",
    displayName: "Alice Chen",
    avatarUrl: users.alice.avatarUrl,
    email: "alice@example.com",
    githubCreatedAt: "2019-03-02T10:00:00.000Z",
    role: "user",
    status: "active",
    suspendedReason: null,
    createdAt: T0,
    lastLoginAt: T1,
  },
  subdomains: [subdomainBase],
  records: [{ ...records.CNAME, subdomain: "alice" }],
  activity: [
    {
      id: ids.audit2,
      action: "record.create",
      actorType: "user",
      target: { type: "record", id: ids.recordCNAME, label: `www.alice.${ROOT_DOMAIN}` },
      metadata: { type: "CNAME", target: "alice.github.io" },
      ip: "203.0.113.24",
      createdAt: T1,
    },
  ],
  sessions: [
    {
      id: "0199e2a1-7c00-7a00-8000-00000000cafe",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      ip: "203.0.113.24",
      createdAt: T0,
      lastSeenAt: T1,
      idleExpiresAt: "2026-10-28T08:00:00.000Z",
      absoluteExpiresAt: "2026-11-30T08:00:00.000Z",
      revokedAt: null,
    },
  ],
  transfers: [
    {
      id: ids.transfer,
      subdomain: "alice",
      direction: "outgoing",
      counterpart: "bob-dev",
      status: "pending",
      keepRecords: true,
      createdAt: T1,
      expiresAt: "2026-10-21T08:00:00.000Z",
      resolvedAt: null,
    },
  ],
  consents: [{ ...CURRENT_LEGAL_VERSIONS, context: "login", acceptedAt: T0 }],
  reports: [],
} as const satisfies UserDataExport;

export const responses = {
  getMeta: {
    rootDomain: ROOT_DOMAIN,
    turnstileSiteKey: "1x00000000000000000000AA",
    registrationOpen: true,
    limits: { subdomainsPerUser: 2, recordsPerSubdomain: 10, nameMinLength: 3, nameMaxLength: 32 },
    allowedRecordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"],
    zoneNearlyFull: false,
    github: { org: "https://github.com/Dev-in-tw", discord: null },
  },
  getStats: { subdomains: 128, members: 117, records: 341, latest: [directoryEntry] },
  getStatus: {
    overall: "degraded",
    components: [
      { id: "api", status: "operational", detail: null },
      { id: "database", status: "operational", detail: null },
      { id: "dns_provider", status: "operational", detail: null },
      { id: "sync_worker", status: "degraded", detail: "同步佇列延遲中" },
    ],
    syncQueue: { pending: 3, failed: 1, oldestPendingSeconds: 42 },
    lastReconcileAt: T1,
    checkedAt: T1,
  },
  listDirectory: { items: [directoryEntry], nextCursor: null },
  checkAvailability: availability.available,
  listPresets: { items: presets },
  createReport: { id: ids.report, createdAt: T1 },
  getMe: me,
  updateMe: { ...me, displayName: "Alice" },
  acceptLegal: { ...CURRENT_LEGAL_VERSIONS, acceptedAt: T1 },
  exportMyData: dataExport,
  listSessions: {
    items: [
      {
        id: "s_8f3a2c",
        current: true,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        ipApprox: "203.0.113.x",
        createdAt: T0,
        lastSeenAt: T1,
      },
      {
        id: "s_1b7d9e",
        current: false,
        userAgent: null,
        ipApprox: null,
        createdAt: T0,
        lastSeenAt: T0,
      },
    ],
  },
  listMyActivity: { items: auditEvents, nextCursor: "eyJpZCI6IjAxOTkifQ" },
  listSubdomains: { items: [subdomains.active, subdomains.pending_review] },
  createSubdomain: subdomains.active,
  getSubdomain: { ...subdomains.active, pendingTransferId: ids.transfer },
  updateSubdomain: { ...subdomains.active, description: "新的描述" },
  releaseSubdomain: subdomains.releasing,
  listSubdomainActivity: { items: auditEvents, nextCursor: null },
  getPropagation: {
    fqdn: `www.alice.${ROOT_DOMAIN}`,
    type: "CNAME",
    expected: ["alice.github.io."],
    resolvers: [
      {
        id: "cloudflare",
        label: "Cloudflare 1.1.1.1",
        answers: ["alice.github.io."],
        matches: true,
        latencyMs: 18,
        error: null,
      },
      {
        id: "google",
        label: "Google 8.8.8.8",
        answers: ["alice.github.io."],
        matches: true,
        latencyMs: 31,
        error: null,
      },
      {
        id: "quad9",
        label: "Quad9 9.9.9.9",
        answers: [],
        matches: false,
        latencyMs: 54,
        error: null,
      },
      {
        id: "quad101",
        label: "TWNIC Quad101",
        answers: [],
        matches: false,
        latencyMs: null,
        error: "逾時",
      },
    ],
    checkedAt: T1,
  },
  listRecords: { items: Object.values(records), usage: { used: 7, limit: 10 } },
  createRecord: records.CNAME,
  replaceRecord: { ...records.CNAME, version: 3 },
  deleteRecord: { ...records.SRV, syncStatus: "deleting" },
  retryRecordSync: { ...records.MX, syncStatus: "pending", syncError: null, version: 1 },
  planPreset: {
    creates: [{ type: "CNAME", name: "@", ttl: 1, target: "alice.github.io" }],
    deletes: [records.A, records.AAAA, records.MX, records.CAA],
    warnings: [
      "現有的 @ A、@ AAAA、@ MX、@ CAA 會和 CNAME 衝突（CNAME 不能與其他紀錄同名），套用時一併刪除",
    ],
  },
  applyPreset: {
    created: [
      {
        type: "CNAME",
        name: "@",
        ttl: 1,
        target: "alice.github.io",
        ...recordMeta(ids.recordApexCNAME, "@", "pending"),
      },
    ],
    deletedIds: [ids.recordA, ids.recordAAAA, ids.recordMX, ids.recordCAA],
  },
  createTransfer: transfer,
  listTransfers: { incoming: [], outgoing: [transfer] },
  acceptTransfer: { ...transfer, status: "accepted", resolvedAt: T2 },
  declineTransfer: { ...transfer, status: "declined", resolvedAt: T2 },
  cancelTransfer: { ...transfer, status: "cancelled", resolvedAt: T2 },
  adminOverview: {
    pendingReview: 2,
    openReports: 1,
    failedSyncs: 1,
    zone: { used: 351, limit: 1000 },
    users: 117,
    subdomains: 128,
  },
  adminListUsers: {
    items: [
      adminUser,
      {
        ...adminUser,
        id: ids.admin,
        githubId: 51485352,
        githubLogin: "HACO8888",
        avatarUrl: users.admin.avatarUrl,
        email: null,
        role: "admin",
        subdomainCount: 0,
        quotaOverride: { subdomains: 5, recordsPerSubdomain: null },
      },
      {
        ...adminUser,
        id: ids.bob,
        githubId: 7654321,
        githubLogin: "bob-dev",
        avatarUrl: users.bob.avatarUrl,
        status: "suspended",
        suspendedReason: "多次架設釣魚網站",
        githubCreatedAt: "2026-10-10T00:00:00.000Z",
      },
    ],
    nextCursor: null,
  },
  adminUpdateUser: { ...adminUser, quotaOverride: { subdomains: 3, recordsPerSubdomain: 20 } },
  adminListSubdomains: {
    items: [adminSubdomain(subdomains.active), adminSubdomain(subdomains.pending_review)],
    nextCursor: null,
  },
  adminApproveSubdomain: adminSubdomain({
    ...subdomains.pending_review,
    status: "active",
    activatedAt: T1,
  }),
  adminRejectSubdomain: adminSubdomain({ ...subdomains.pending_review, status: "releasing" }),
  adminSuspendSubdomain: adminSubdomain(subdomains.suspended),
  adminUnsuspendSubdomain: adminSubdomain({
    ...subdomains.suspended,
    status: "active",
    suspendedReason: null,
  }),
  adminListReports: {
    items: [
      {
        id: ids.report,
        subdomain: "free-gift",
        subdomainExists: true,
        category: "phishing",
        details: "這個網站假冒銀行登入頁面，要求輸入網銀帳號密碼",
        contactEmail: "reporter@example.com",
        reporter: null,
        status: "open",
        handledBy: null,
        resolutionNote: null,
        createdAt: T1,
        resolvedAt: null,
        redactedAt: null,
      },
      {
        id: "0199e2a4-3000-7000-a000-000000000002",
        subdomain: "old-spam",
        subdomainExists: false,
        category: "spam",
        details: "",
        contactEmail: null,
        reporter: null,
        status: "dismissed",
        handledBy: users.admin,
        resolutionNote: "查無違規",
        createdAt: "2025-09-01T08:00:00.000Z",
        resolvedAt: "2025-09-02T08:00:00.000Z",
        redactedAt: T1,
      },
    ],
    nextCursor: null,
  },
  adminResolveReport: {
    id: ids.report,
    subdomain: "free-gift",
    subdomainExists: true,
    category: "phishing",
    details: "這個網站假冒銀行登入頁面，要求輸入網銀帳號密碼",
    contactEmail: "reporter@example.com",
    reporter: null,
    status: "actioned",
    handledBy: users.admin,
    resolutionNote: "確認為釣魚網站，已停權",
    createdAt: T1,
    resolvedAt: T2,
  },
  adminListReserved: {
    items: [
      { name: "admin", category: "system", note: null, createdBy: null, createdAt: T0 },
      {
        name: "paypal",
        category: "brand",
        note: "國際支付品牌",
        createdBy: users.admin,
        createdAt: T0,
      },
      { name: "jason", category: "zone", note: "zone 既有紀錄", createdBy: null, createdAt: T0 },
    ],
    nextCursor: null,
  },
  adminAddReserved: {
    name: "esun",
    category: "brand",
    note: "玉山銀行",
    createdBy: users.admin,
    createdAt: T1,
  },
  adminAuditLog: { items: auditEvents, nextCursor: null },
  adminZone: {
    plan: "Free Website",
    usage: { used: 351, limit: 1000 },
    systemRecords: 6,
    managedRecords: 345,
    drift: [
      {
        kind: "missing",
        fqdn: `alice.${ROOT_DOMAIN}`,
        type: "MX",
        detail: "DB 有、provider 沒有，已重新排入",
      },
      {
        kind: "unmanaged",
        fqdn: `jason.${ROOT_DOMAIN}`,
        type: "A",
        detail: "沒有 dit: 標記，請人工確認",
      },
    ],
    deadJobs: [{ id: 42, kind: "upsert_record", lastError: "UPSTREAM_DNS_ERROR", updatedAt: T1 }],
    lastReconcileAt: T1,
  },
  adminGetSettings: { registrationOpen: true, reviewMode: "risk" },
  adminUpdateSettings: { registrationOpen: false, reviewMode: "all" },
} as const satisfies { [N in JsonEndpoint]: ResponseOf<N> };

/** SSE 事件：每種 type 一個 */
export const events = {
  "record.sync": {
    type: "record.sync",
    subdomain: "alice",
    recordId: ids.recordCNAME,
    version: 2,
    syncStatus: "synced",
    syncError: null,
  },
  "record.deleted": { type: "record.deleted", subdomain: "alice", recordId: ids.recordSRV },
  "subdomain.status": { type: "subdomain.status", subdomain: "paypa1-shop", status: "active" },
  "transfer.updated": { type: "transfer.updated", transferId: ids.transfer, status: "accepted" },
  ping: { type: "ping", at: T1 },
} as const satisfies { [K in ServerEvent["type"]]: ServerEvent & { type: K } };

/**
 * 批次寫入模式（DNS provider 為 Lazco DNS，contract-v1.3）：pending 的紀錄帶預計生效時間，
 * `/status` 與 `/admin/zone` 帶批次額度與排程。
 */
const batchingState = {
  intervalSeconds: 1080,
  nextBatchAt: "2026-10-14T09:18:00.000Z",
  lastBatchAt: "2026-10-14T09:00:00.000Z",
  pausedUntil: null,
  batchesToday: 30,
  dailyBudget: 80,
} as const;

export const batching = {
  record: { ...records.CNAME, syncEta: batchingState.nextBatchAt },
  event: {
    ...events["record.sync"],
    syncStatus: "pending",
    syncEta: batchingState.nextBatchAt,
  },
  getStatus: {
    ...responses.getStatus,
    syncQueue: { ...responses.getStatus.syncQueue, batching: batchingState },
  },
  adminZone: {
    ...responses.adminZone,
    plan: "lazco",
    usage: { used: 120, limit: 500 },
    provider: "lazco",
    usageUnit: "rrset",
    batching: batchingState,
  },
} as const satisfies {
  record: DnsRecord;
  event: ServerEvent;
  getStatus: ResponseOf<"getStatus">;
  adminZone: ResponseOf<"adminZone">;
};

/** 錯誤回應範例 */
export const problems = {
  recordConflict: {
    type: problemType("RECORD_CONFLICT"),
    title: "Record conflicts with an existing record",
    status: 409,
    code: "RECORD_CONFLICT",
    detail: "alice.dev-in.tw 已有 CNAME，不能再新增其他類型的紀錄",
    instance: "/api/v1/subdomains/alice/records",
    requestId: "01JA8Z6Q3W4X5Y6Z7A8B9C0D1E",
    errors: [{ path: "name", code: "CNAME_EXCLUSIVE", message: "同名已存在 CNAME" }],
  },
  ipNotPublic: {
    type: problemType("IP_NOT_PUBLIC"),
    title: "Address is not a public unicast address",
    status: 400,
    code: "IP_NOT_PUBLIC",
    detail: "10.0.0.1 是私有位址，外部無法連線",
    requestId: "01JA8Z6Q3W4X5Y6Z7A8B9C0D1F",
    errors: [{ path: "address", code: "IP_NOT_PUBLIC", message: "必須是公網位址" }],
  },
  rateLimited: {
    type: problemType("RATE_LIMITED"),
    title: "Too many requests",
    status: 429,
    code: "RATE_LIMITED",
    requestId: "01JA8Z6Q3W4X5Y6Z7A8B9C0D1G",
    retryAfter: 30,
  },
  notImplemented: {
    type: problemType("NOT_IMPLEMENTED"),
    title: "Not implemented",
    status: 501,
    code: "NOT_IMPLEMENTED",
    detail: "這個功能即將推出",
    requestId: "01JA8Z6Q3W4X5Y6Z7A8B9C0D1H",
  },
} as const satisfies Record<string, Problem>;

/** 有 body 的端點各一個合法的請求範例（給 mock server 與後端測試） */
type BodyEndpoint = {
  [N in EndpointName]: Endpoints[N] extends { body: unknown } ? N : never;
}[EndpointName];

export const requests = {
  createReport: {
    subdomain: "free-gift",
    category: "phishing",
    details: "這個網站假冒銀行登入頁面，要求輸入網銀帳號密碼",
    turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
  },
  devLogin: { githubLogin: "alice", role: "user", githubAgeDays: 365 },
  updateMe: { displayName: "Alice" },
  deleteMe: { confirm: "alice" },
  acceptLegal: CURRENT_LEGAL_VERSIONS,
  createSubdomain: {
    name: "alice",
    description: "Alice 的個人網站與部落格",
    acceptTerms: true,
    turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    ...CURRENT_LEGAL_VERSIONS,
  },
  updateSubdomain: { showInDirectory: true },
  releaseSubdomain: { confirm: "alice" },
  createRecord: { type: "CNAME", name: "www", ttl: 300, target: "alice.github.io" },
  replaceRecord: { type: "A", name: "www", ttl: 1, address: "185.199.109.153" },
  planPreset: { recordName: "@", params: { githubUser: "alice" } },
  applyPreset: { recordName: "@", params: { githubUser: "alice" } },
  createTransfer: { toGithubLogin: "bob-dev", keepRecords: false },
  adminUpdateUser: { status: "suspended", reason: "多次架設釣魚網站" },
  adminApproveSubdomain: {},
  adminRejectSubdomain: { reason: "名稱假冒知名品牌" },
  adminSuspendSubdomain: { reason: "檢舉成立：釣魚網站" },
  adminUnsuspendSubdomain: { reason: "已移除違規內容" },
  adminResolveReport: {
    status: "actioned",
    resolutionNote: "確認為釣魚網站，已停權",
    suspendSubdomain: true,
  },
  adminAddReserved: { name: "esun", category: "brand", note: "玉山銀行" },
  adminUpdateSettings: { registrationOpen: false },
} as const satisfies { [N in BodyEndpoint]: NonNullable<RequestOf<N>["body"]> };
