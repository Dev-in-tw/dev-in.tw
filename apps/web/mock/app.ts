/**
 * Dev-in.tw mock API（PLAN §5.4）：Hono，掛在 /api/v1，依合約 `endpoints` 自動註冊每一個端點。
 *
 * - 請求的 params、query、body 都用合約的 zod schema 驗證；回應也用合約 schema parse，
 *   mock 一旦偏離合約就會回 500 並印出原因。
 * - 依合約實作「合理行為」：IDOR 回 404、Origin 檢查（CSRF）、If-Match 412、私有 IP、
 *   CNAME 排他、pending 1.2 秒後透過 SSE 推送 synced。
 * - `/api/__mock/*`：reset、config（把 P1 端點切成 501）、假的 GitHub 授權頁與頭像。
 */
import {
  type AdminSubdomain,
  type AdminUser,
  type AuditEvent,
  type DnsRecord,
  type EndpointName,
  ERROR_STATUS,
  type ErrorCode,
  endpoints,
  type FieldIssue,
  type Me,
  type PresetId,
  type Problem,
  type Propagation,
  problemType,
  type RecordInput,
  type ResponseOf,
  type ServerEvent,
  type Subdomain,
  type Transfer,
} from "@dit/contract";
import { ROOT_DOMAIN, responses } from "@dit/contract/fixtures";
import { CURRENT_LEGAL_VERSIONS, isCurrentConsent } from "@dit/contract/legal";
import { PRESETS, planPreset as planPresetRules } from "@dit/dns";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";
import { ALLOWED_TYPES, availability, checkRecord, dataOf } from "./rules.ts";
import {
  avatarUrl,
  findUser,
  findUserByLogin,
  LIMITS,
  type MockAudit,
  type MockSession,
  type MockSubdomain,
  type MockTransfer,
  type MockUser,
  nextId,
  now,
  publicUser,
  recordQuota,
  resetState,
  state,
  subdomainQuota,
  zoneUsed,
} from "./state.ts";

const SESSION_COOKIE = "__Host-dit_session";

class MockProblem extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  readonly errors: FieldIssue[] | undefined;
  constructor(code: ErrorCode, detail?: string, errors?: FieldIssue[]) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.errors = errors;
  }
}

const fail = (code: ErrorCode, detail?: string, errors?: FieldIssue[]): never => {
  throw new MockProblem(code, detail, errors);
};

let requestSeq = 0;
function problemBody(code: ErrorCode, instance: string, detail?: string, errors?: FieldIssue[]) {
  requestSeq += 1;
  const body: Problem = {
    type: problemType(code),
    title: code
      .toLowerCase()
      .replaceAll("_", " ")
      .replace(/^\w/, (s) => s.toUpperCase()),
    status: ERROR_STATUS[code],
    code,
    instance,
    requestId: `mock-${requestSeq.toString().padStart(6, "0")}`,
  };
  if (detail) body.detail = detail;
  if (errors?.length) body.errors = errors;
  if (code === "RATE_LIMITED") body.retryAfter = 30;
  return body;
}

function problemResponse(c: Context, p: Problem): Response {
  return c.body(JSON.stringify(p), p.status as 400, {
    "content-type": "application/problem+json",
    "x-request-id": p.requestId,
  });
}

function originOf(c: Context): string {
  // dev:mock 時 RSC 直接打 :3001，產生的頭像網址要指回瀏覽器看到的 origin（:3000）
  if (process.env.MOCK_PUBLIC_ORIGIN) return process.env.MOCK_PUBLIC_ORIGIN;
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "localhost";
  return `${proto}://${host}`;
}

function readCookie(c: Context, name: string): string | undefined {
  const header = c.req.header("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const [k, ...v] = part.split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function sessionCookie(token: string, maxAge = 5_184_000): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function currentSession(c: Context): { session: MockSession; user: MockUser } | null {
  const token = readCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = state.sessions.find((s) => s.token === token);
  if (!session) return null;
  const user = findUser(session.userId);
  if (!user) return null;
  return { session, user };
}

function createSession(c: Context, user: MockUser): MockSession {
  const session: MockSession = {
    id: nextId("session"),
    token: crypto.randomUUID(),
    userId: user.id,
    userAgent: c.req.header("user-agent") ?? null,
    ipApprox: "127.0.0.x",
    createdAt: now(),
    lastSeenAt: now(),
  };
  state.sessions.push(session);
  user.lastLoginAt = now();
  return session;
}

function audit(
  action: string,
  actor: MockUser | null,
  target: AuditEvent["target"],
  metadata: Record<string, unknown> = {},
  subdomain: string | null = null,
) {
  const event: MockAudit = {
    id: nextId("audit"),
    action,
    actor: null,
    actorType: actor ? (actor.role === "admin" ? "admin" : "user") : "system",
    target,
    metadata,
    createdAt: now(),
    actorId: actor?.id ?? null,
    subdomain,
  };
  state.audit.unshift(event);
}

function auditOut(e: MockAudit, origin: string): AuditEvent {
  const { actorId, subdomain: _subdomain, ...rest } = e;
  const actor = actorId ? findUser(actorId) : undefined;
  return { ...rest, actor: actor ? publicUser(actor, origin) : rest.actor };
}

/* ---------------- SSE ---------------- */

type Listener = (event: ServerEvent) => void;
const listeners = new Map<string, Set<Listener>>();

function emit(userId: string, event: ServerEvent) {
  for (const fn of listeners.get(userId) ?? []) fn(event);
}

function ownerOf(sub: string): string | undefined {
  return state.subdomains.find((s) => s.name === sub)?.ownerId;
}

/** 假的 sync worker：pending → synced（或 error），deleting → 移除 */
function scheduleSync(sub: string, recordId: string) {
  setTimeout(() => {
    const list = state.records.get(sub);
    const record = list?.find((r) => r.id === recordId);
    const owner = ownerOf(sub);
    if (!list || !record || !owner) return;
    if (record.syncStatus === "deleting") {
      state.records.set(
        sub,
        list.filter((r) => r.id !== recordId),
      );
      refreshUsage(sub);
      emit(owner, { type: "record.deleted", subdomain: sub, recordId });
      return;
    }
    const failing = dataOf(record).includes("sync-error");
    record.syncStatus = failing ? "error" : "synced";
    record.syncError = failing
      ? { code: "UPSTREAM_DNS_ERROR", message: "DNS 服務暫時無法寫入，系統會自動重試" }
      : null;
    record.updatedAt = now();
    syncedAt.set(record.id, Date.now());
    emit(owner, {
      type: "record.sync",
      subdomain: sub,
      recordId,
      version: record.version,
      syncStatus: record.syncStatus,
      syncError: record.syncError,
    });
  }, state.config.syncDelayMs);
}

const syncedAt = new Map<string, number>();

function refreshUsage(sub: string) {
  const s = state.subdomains.find((x) => x.name === sub);
  const owner = s ? findUser(s.ownerId) : undefined;
  if (s && owner) {
    s.records = {
      used: (state.records.get(sub) ?? []).filter((r) => r.syncStatus !== "deleting").length,
      limit: recordQuota(owner),
    };
  }
}

/* ---------------- helpers ---------------- */

function subOut(s: MockSubdomain): Subdomain {
  const { ownerId: _ownerId, ...rest } = s;
  return { ...rest, records: { ...rest.records } };
}

function adminSubOut(s: MockSubdomain, origin: string): AdminSubdomain {
  const owner = findUser(s.ownerId);
  return {
    ...subOut(s),
    owner: {
      githubLogin: owner?.githubLogin ?? "unknown",
      displayName: owner?.displayName ?? null,
      avatarUrl: avatarUrl(owner?.githubLogin ?? "unknown", origin),
      id: owner?.id ?? s.ownerId,
      githubCreatedAt: owner?.githubCreatedAt ?? s.createdAt,
    },
  };
}

function meOut(u: MockUser, origin: string): Me {
  return {
    id: u.id,
    githubId: u.githubId,
    githubLogin: u.githubLogin,
    displayName: u.displayName,
    avatarUrl: avatarUrl(u.githubLogin, origin),
    email: u.email,
    role: u.role,
    status: u.status,
    quota: {
      subdomains: {
        used: state.subdomains.filter((s) => s.ownerId === u.id).length,
        limit: subdomainQuota(u),
      },
      recordsPerSubdomain: recordQuota(u),
    },
    incomingTransfers: state.transfers.filter((t) => t.toId === u.id && t.status === "pending")
      .length,
    createdAt: u.createdAt,
    consent: u.consent,
    consentRequired: !isCurrentConsent(u.consent),
  };
}

function adminUserOut(u: MockUser, origin: string): AdminUser {
  return {
    id: u.id,
    githubId: u.githubId,
    githubLogin: u.githubLogin,
    avatarUrl: avatarUrl(u.githubLogin, origin),
    email: u.email,
    role: u.role,
    status: u.status,
    suspendedReason: u.suspendedReason,
    githubCreatedAt: u.githubCreatedAt,
    subdomainCount: state.subdomains.filter((s) => s.ownerId === u.id).length,
    quotaOverride: u.quotaOverride,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

function transferOut(t: MockTransfer, origin: string): Transfer {
  const { fromId, toId, ...rest } = t;
  const from = findUser(fromId);
  const to = findUser(toId);
  const fallback = {
    githubLogin: "ghost",
    displayName: null,
    avatarUrl: avatarUrl("ghost", origin),
  };
  return {
    ...rest,
    from: from ? publicUser(from, origin) : fallback,
    to: to ? publicUser(to, origin) : fallback,
  };
}

function ownedSubdomain(user: MockUser, name: string): MockSubdomain {
  const s = state.subdomains.find((x) => x.name === name);
  // 存取別人的子網域一律回 404（不回 403，避免透露存在與否）
  if (!s || (s.ownerId !== user.id && user.role !== "admin")) return fail("NOT_FOUND");
  return s;
}

function adminSubdomain(name: string): MockSubdomain {
  return state.subdomains.find((x) => x.name === name) ?? fail("NOT_FOUND");
}

function requireActive(s: MockSubdomain) {
  if (s.status !== "active") fail("SUBDOMAIN_NOT_ACTIVE", "子網域目前不是啟用狀態");
}

function paged<T>(
  items: T[],
  limit = 20,
  cursor?: string,
): { items: T[]; nextCursor: string | null } {
  const start = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
  const slice = items.slice(start, start + limit);
  const next = start + limit < items.length ? String(start + limit) : null;
  return { items: slice, nextCursor: next };
}

function idempotent<T>(key: string | undefined, scope: string, body: unknown, run: () => T): T {
  if (!key) return run();
  const id = `${scope}:${key}`;
  const hash = JSON.stringify(body);
  const hit = state.idempotency.get(id);
  if (hit) {
    if (hit.hash !== hash)
      fail("IDEMPOTENCY_KEY_REUSED", "同一個 Idempotency-Key 不能用在不同的內容");
    return hit.body as T;
  }
  const result = run();
  state.idempotency.set(id, { hash, status: 200, body: result });
  return result;
}

function ifMatchVersion(c: Context): number | null {
  const raw = c.req.header("if-match");
  if (!raw) return null;
  const n = Number.parseInt(raw.replaceAll('"', ""), 10);
  return Number.isFinite(n) ? n : null;
}

/* ---------------- handlers ---------------- */

interface Ctx<N extends EndpointName> {
  c: Context;
  origin: string;
  user: MockUser | null;
  session: MockSession | null;
  params: Endpoints<N, "params">;
  query: Endpoints<N, "query">;
  body: Endpoints<N, "body">;
}
type Endpoints<N extends EndpointName, K extends string> = (typeof endpoints)[N] extends {
  [P in K]: infer S extends z.ZodType;
}
  ? z.output<S>
  : undefined;

type Reply<N extends EndpointName> = { status?: number; body: ResponseOf<N>; headers?: Headers };
type Handler<N extends EndpointName> = (ctx: Ctx<N>) => Reply<N> | Response | Promise<Response>;

const me = (ctx: { user: MockUser | null }): MockUser => ctx.user ?? fail("UNAUTHENTICATED");

const handlers: { [N in EndpointName]: Handler<N> } = {
  getMeta: () => ({
    body: {
      ...responses.getMeta,
      limits: { ...responses.getMeta.limits },
      allowedRecordTypes: [...ALLOWED_TYPES],
      registrationOpen: state.settings.registrationOpen,
      zoneNearlyFull: state.config.capacityFull,
      // 不載入真的 Turnstile（e2e 不依賴外網）；前端遇到 mock- 開頭的 key 會顯示假的驗證框
      turnstileSiteKey: "mock-turnstile",
      github: { org: responses.getMeta.github.org, discord: "https://discord.gg/dev-in-tw" },
    },
  }),
  getStats: ({ origin }) => {
    const listed = directory(origin);
    const members = new Set(state.subdomains.map((s) => s.ownerId)).size;
    let records = 0;
    for (const list of state.records.values()) records += list.length;
    return {
      body: {
        subdomains: state.subdomains.filter((s) => s.status === "active").length + 100,
        members: members + 96,
        records: records + 300,
        latest: listed.slice(0, 10),
      },
    };
  },
  getStatus: () => ({
    body: {
      ...responses.getStatus,
      components: responses.getStatus.components.map((x) => ({ ...x })),
      syncQueue: { ...responses.getStatus.syncQueue },
      checkedAt: now(),
    },
  }),
  listDirectory: ({ origin, query }) => ({
    body: paged(directory(origin), query.limit, query.cursor),
  }),
  checkAvailability: ({ params, user }) => ({ body: availability(params.name, user) }),
  // 真實後端 10 個 preset 都已支援
  listPresets: () => ({
    body: {
      items: PRESETS.map((p) => ({
        ...p,
        available: true,
        params: p.params.map((x) => ({ ...x })),
      })),
    },
  }),
  createReport: ({ body, user }) => {
    if (body.turnstileToken === "fail") fail("TURNSTILE_FAILED", "人機驗證失敗，請再試一次");
    const id = nextId("report");
    state.reports.unshift({
      id,
      subdomain: body.subdomain,
      subdomainExists: state.subdomains.some((s) => s.name === body.subdomain),
      category: body.category,
      details: body.details,
      contactEmail: body.contactEmail ?? null,
      reporter: null,
      status: "open",
      handledBy: null,
      resolutionNote: null,
      createdAt: now(),
      resolvedAt: null,
    });
    audit("report.create", user, { type: "report", id, label: body.subdomain });
    return { status: 201, body: { id, createdAt: now() } };
  },
  startGithubLogin: ({ c, query }) => {
    const redirect = safeRedirect(query.redirect);
    return c.redirect(`/api/__mock/github?redirect=${encodeURIComponent(redirect)}`, 302);
  },
  githubCallback: ({ c }) => c.redirect("/login?error=oauth_failed", 303),
  devLogin: ({ c, body }) => {
    const user = loginAs(body.githubLogin, body.role, body.githubAgeDays);
    if (user.status === "suspended") fail("ACCOUNT_SUSPENDED");
    const session = createSession(c, user);
    return c.body(null, 204, { "set-cookie": sessionCookie(session.token) });
  },
  logout: (ctx) => {
    state.sessions = state.sessions.filter((s) => s.id !== ctx.session?.id);
    audit("auth.logout", ctx.user, { type: "user", id: me(ctx).id, label: me(ctx).githubLogin });
    return ctx.c.body(null, 204, { "set-cookie": sessionCookie("", 0) });
  },
  getMe: (ctx) => ({ body: meOut(me(ctx), ctx.origin) }),
  updateMe: (ctx) => {
    const u = me(ctx);
    if (ctx.body.displayName !== undefined) u.displayName = ctx.body.displayName;
    return { body: meOut(u, ctx.origin) };
  },
  deleteMe: (ctx) => {
    const u = me(ctx);
    if (ctx.body.confirm !== u.githubLogin)
      fail("CONFIRMATION_MISMATCH", "請輸入你的 GitHub 帳號名稱");
    for (const s of state.subdomains.filter((x) => x.ownerId === u.id)) {
      state.holds.set(s.name, new Date(Date.now() + 30 * 86_400_000).toISOString());
      state.records.delete(s.name);
    }
    state.subdomains = state.subdomains.filter((x) => x.ownerId !== u.id);
    state.sessions = state.sessions.filter((s) => s.userId !== u.id);
    state.users = state.users.filter((x) => x.id !== u.id);
    return ctx.c.body(null, 202, { "set-cookie": sessionCookie("", 0) });
  },
  listSessions: (ctx) => {
    const u = me(ctx);
    return {
      body: {
        items: state.sessions
          .filter((s) => s.userId === u.id)
          .map((s) => ({
            id: s.id,
            current: s.id === ctx.session?.id,
            userAgent: s.userAgent,
            ipApprox: s.ipApprox,
            createdAt: s.createdAt,
            lastSeenAt: s.lastSeenAt,
          })),
      },
    };
  },
  revokeSession: (ctx) => {
    const u = me(ctx);
    const target = state.sessions.find((s) => s.id === ctx.params.sessionId && s.userId === u.id);
    if (!target) fail("NOT_FOUND");
    state.sessions = state.sessions.filter((s) => s.id !== ctx.params.sessionId);
    audit("session.revoke", u, { type: "session", id: ctx.params.sessionId, label: "session" });
    return ctx.c.body(null, 204);
  },
  revokeOtherSessions: (ctx) => {
    const u = me(ctx);
    state.sessions = state.sessions.filter((s) => s.userId !== u.id || s.id === ctx.session?.id);
    return ctx.c.body(null, 204);
  },
  acceptLegal: (ctx) => {
    const u = me(ctx);
    if (!isCurrentConsent(ctx.body)) fail("CONSENT_REQUIRED");
    u.consent = { ...CURRENT_LEGAL_VERSIONS, acceptedAt: now() };
    audit("legal.accept", u, { type: "user", id: u.id, label: u.githubLogin }, { ...ctx.body });
    return { body: { ...u.consent } };
  },
  exportMyData: (ctx) => {
    const u = me(ctx);
    const owned = state.subdomains.filter((s) => s.ownerId === u.id);
    return {
      body: {
        format: "dev-in.tw/user-data-export@1",
        generatedAt: now(),
        account: {
          id: u.id,
          githubId: u.githubId,
          githubLogin: u.githubLogin,
          displayName: u.displayName,
          avatarUrl: avatarUrl(u.githubLogin, ctx.origin),
          email: u.email,
          githubCreatedAt: u.githubCreatedAt,
          role: u.role,
          status: u.status,
          suspendedReason: u.suspendedReason,
          createdAt: u.createdAt,
          lastLoginAt: u.lastLoginAt,
        },
        subdomains: owned.map(subOut),
        records: owned.flatMap((s) =>
          (state.records.get(s.name) ?? []).map((r) => ({ ...r, subdomain: s.name })),
        ),
        activity: state.audit
          .filter((e) => e.actorId === u.id)
          .map((e) => ({
            id: e.id,
            action: e.action,
            actorType: e.actorType,
            target: { ...e.target },
            metadata: { ...e.metadata },
            ip: null,
            createdAt: e.createdAt,
          })),
        sessions: state.sessions
          .filter((s) => s.userId === u.id)
          .map((s) => ({
            id: s.id,
            userAgent: s.userAgent,
            ip: null,
            createdAt: s.createdAt,
            lastSeenAt: s.lastSeenAt,
            idleExpiresAt: s.lastSeenAt,
            absoluteExpiresAt: s.lastSeenAt,
            revokedAt: null,
          })),
        transfers: state.transfers
          .filter((t) => t.fromId === u.id || t.toId === u.id)
          .map((t) => ({
            id: t.id,
            subdomain: t.subdomain,
            direction: t.fromId === u.id ? ("outgoing" as const) : ("incoming" as const),
            counterpart: findUser(t.fromId === u.id ? t.toId : t.fromId)?.githubLogin ?? null,
            status: t.status,
            keepRecords: t.keepRecords,
            createdAt: t.createdAt,
            expiresAt: t.expiresAt,
            resolvedAt: t.resolvedAt,
          })),
        consents: u.consent ? [{ ...u.consent, context: "login" as const }] : [],
        reports: [],
      },
      headers: new Headers({
        "content-disposition": `attachment; filename="dev-in-tw-${u.githubLogin.toLowerCase()}.json"`,
      }),
    };
  },
  listMyActivity: (ctx) => {
    const u = me(ctx);
    const items = state.audit
      .filter((e) => e.actorId === u.id || ownerOf(e.subdomain ?? "") === u.id)
      .map((e) => auditOut(e, ctx.origin));
    return { body: paged(items, ctx.query.limit, ctx.query.cursor) };
  },
  events: (ctx) => {
    const u = me(ctx);
    return streamSSE(ctx.c, async (stream) => {
      const queue: ServerEvent[] = [];
      let wake: (() => void) | null = null;
      const listener: Listener = (event) => {
        queue.push(event);
        wake?.();
      };
      const set = listeners.get(u.id) ?? new Set();
      set.add(listener);
      listeners.set(u.id, set);
      stream.onAbort(() => {
        set.delete(listener);
        wake?.();
      });
      await stream.writeSSE({ event: "ping", data: JSON.stringify({ type: "ping", at: now() }) });
      while (!stream.aborted) {
        const event = queue.shift();
        if (event) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 25_000);
        });
        wake = null;
        if (queue.length === 0 && !stream.aborted) {
          await stream.writeSSE({
            event: "ping",
            data: JSON.stringify({ type: "ping", at: now() }),
          });
        }
      }
    });
  },
  listSubdomains: (ctx) => {
    const u = me(ctx);
    return { body: { items: state.subdomains.filter((s) => s.ownerId === u.id).map(subOut) } };
  },
  createSubdomain: (ctx) => {
    const u = me(ctx);
    const body = ctx.body;
    return {
      status: 201,
      body: idempotent(ctx.c.req.header("idempotency-key"), `sub:${u.id}`, body, () => {
        if (!state.settings.registrationOpen) fail("REGISTRATION_CLOSED", "目前暫停開放申請");
        if (body.termsVersion !== undefined || body.privacyVersion !== undefined) {
          const versions = {
            termsVersion: body.termsVersion ?? "",
            privacyVersion: body.privacyVersion ?? "",
          };
          if (!isCurrentConsent(versions)) fail("CONSENT_REQUIRED");
          u.consent = { ...CURRENT_LEGAL_VERSIONS, acceptedAt: now() };
        } else if (!isCurrentConsent(u.consent)) {
          fail("CONSENT_REQUIRED");
        }
        if (body.turnstileToken === "fail") fail("TURNSTILE_FAILED", "人機驗證失敗，請再試一次");
        const check = availability(body.name, u);
        if (check.status === "invalid") fail("NAME_INVALID", check.reason);
        if (check.status === "reserved") fail("NAME_RESERVED", check.reason);
        if (check.status === "taken") fail("NAME_TAKEN", check.reason);
        if (check.status === "cooldown") fail("NAME_COOLDOWN", check.reason);
        if (check.status === "capacity_full") fail("ZONE_CAPACITY_EXHAUSTED", check.reason);
        const owned = state.subdomains.filter((s) => s.ownerId === u.id).length;
        if (owned >= subdomainQuota(u)) {
          fail("SUBDOMAIN_QUOTA_EXCEEDED", `每個人最多 ${subdomainQuota(u)} 個子網域`);
        }
        const ageDays = (Date.now() - Date.parse(u.githubCreatedAt)) / 86_400_000;
        const reasons = [...(check.reviewReasons ?? [])];
        if (ageDays < 30) reasons.unshift("account_too_new");
        if (state.settings.reviewMode === "all" && reasons.length === 0) reasons.push("review_all");
        const review = state.settings.reviewMode !== "none" && reasons.length > 0;
        const at = now();
        const sub: MockSubdomain = {
          name: check.name,
          fqdn: check.fqdn,
          status: review ? "pending_review" : "active",
          description: body.description,
          showInDirectory: false,
          records: { used: 0, limit: recordQuota(u) },
          reviewReasons: review ? reasons : [],
          suspendedReason: null,
          pendingTransferId: null,
          createdAt: at,
          activatedAt: review ? null : at,
          updatedAt: at,
          ownerId: u.id,
        };
        state.subdomains.push(sub);
        state.records.set(sub.name, []);
        audit(
          "subdomain.create",
          u,
          { type: "subdomain", id: sub.name, label: sub.fqdn },
          {},
          sub.name,
        );
        return subOut(sub);
      }),
    };
  },
  getSubdomain: (ctx) => ({ body: subOut(ownedSubdomain(me(ctx), ctx.params.name)) }),
  updateSubdomain: (ctx) => {
    const u = me(ctx);
    const s = ownedSubdomain(u, ctx.params.name);
    if (ctx.body.description !== undefined) s.description = ctx.body.description;
    if (ctx.body.showInDirectory !== undefined) s.showInDirectory = ctx.body.showInDirectory;
    s.updatedAt = now();
    audit(
      "subdomain.update",
      u,
      { type: "subdomain", id: s.name, label: s.fqdn },
      { ...ctx.body },
      s.name,
    );
    return { body: subOut(s) };
  },
  releaseSubdomain: (ctx) => {
    const u = me(ctx);
    const s = ownedSubdomain(u, ctx.params.name);
    if (ctx.body.confirm !== s.name) fail("CONFIRMATION_MISMATCH", "請輸入完整的子網域名稱");
    s.status = "releasing";
    audit("subdomain.release", u, { type: "subdomain", id: s.name, label: s.fqdn }, {}, s.name);
    const out = subOut(s);
    setTimeout(() => {
      state.subdomains = state.subdomains.filter((x) => x.name !== s.name);
      state.records.delete(s.name);
      state.holds.set(s.name, new Date(Date.now() + 30 * 86_400_000).toISOString());
    }, state.config.syncDelayMs);
    return { status: 202, body: out };
  },
  listSubdomainActivity: (ctx) => {
    const s = ownedSubdomain(me(ctx), ctx.params.name);
    const items = state.audit
      .filter((e) => e.subdomain === s.name)
      .map((e) => auditOut(e, ctx.origin));
    return { body: paged(items, ctx.query.limit, ctx.query.cursor) };
  },
  getPropagation: (ctx) => {
    const s = ownedSubdomain(me(ctx), ctx.params.name);
    return { body: propagation(s, ctx.query.recordName, ctx.query.type) };
  },
  listRecords: (ctx) => {
    const s = ownedSubdomain(me(ctx), ctx.params.name);
    const items = (state.records.get(s.name) ?? []).map((r) => ({ ...r }));
    return { body: { items, usage: { ...s.records } } };
  },
  createRecord: (ctx) => {
    const u = me(ctx);
    const s = ownedSubdomain(u, ctx.params.name);
    return {
      status: 202,
      body: idempotent(ctx.c.req.header("idempotency-key"), `rec:${s.name}`, ctx.body, () => {
        requireActive(s);
        const list = state.records.get(s.name) ?? [];
        if (list.filter((r) => r.syncStatus !== "deleting").length >= recordQuota(u)) {
          fail("RECORD_QUOTA_EXCEEDED", `每個子網域最多 ${recordQuota(u)} 筆紀錄`);
        }
        if (state.config.capacityFull) fail("ZONE_CAPACITY_EXHAUSTED", "zone 容量已滿");
        assertRules(ctx.body, s, list, u);
        const at = now();
        const record = {
          ...ctx.body,
          id: nextId("record"),
          fqdn: fqdnOf(ctx.body.name, s.name),
          version: 1,
          syncStatus: "pending",
          syncError: null,
          createdAt: at,
          updatedAt: at,
        } as DnsRecord;
        list.push(record);
        state.records.set(s.name, list);
        refreshUsage(s.name);
        scheduleSync(s.name, record.id);
        audit(
          "record.create",
          u,
          { type: "record", id: record.id, label: record.fqdn },
          { type: record.type },
          s.name,
        );
        return { ...record };
      }),
    };
  },
  replaceRecord: (ctx) => {
    const u = me(ctx);
    const s = ownedSubdomain(u, ctx.params.name);
    requireActive(s);
    const list = state.records.get(s.name) ?? [];
    const current = list.find((r) => r.id === ctx.params.recordId) ?? fail("NOT_FOUND");
    const expected = ifMatchVersion(ctx.c);
    if (expected !== null && expected !== current.version) {
      fail("VERSION_CONFLICT", "這筆紀錄已在別處被修改");
    }
    assertRules(
      ctx.body,
      s,
      list.filter((r) => r.id !== current.id),
      u,
    );
    const next = {
      ...ctx.body,
      id: current.id,
      fqdn: fqdnOf(ctx.body.name, s.name),
      version: current.version + 1,
      syncStatus: "pending",
      syncError: null,
      createdAt: current.createdAt,
      updatedAt: now(),
    } as DnsRecord;
    state.records.set(
      s.name,
      list.map((r) => (r.id === current.id ? next : r)),
    );
    scheduleSync(s.name, next.id);
    audit(
      "record.replace",
      u,
      { type: "record", id: next.id, label: next.fqdn },
      { type: next.type },
      s.name,
    );
    return { status: 202, body: { ...next } };
  },
  deleteRecord: (ctx) => {
    const u = me(ctx);
    const s = ownedSubdomain(u, ctx.params.name);
    const list = state.records.get(s.name) ?? [];
    const current = list.find((r) => r.id === ctx.params.recordId) ?? fail("NOT_FOUND");
    const expected = ifMatchVersion(ctx.c);
    if (expected !== null && expected !== current.version) {
      fail("VERSION_CONFLICT", "這筆紀錄已在別處被修改");
    }
    current.syncStatus = "deleting";
    current.updatedAt = now();
    refreshUsage(s.name);
    scheduleSync(s.name, current.id);
    audit(
      "record.delete",
      u,
      { type: "record", id: current.id, label: current.fqdn },
      { type: current.type },
      s.name,
    );
    return { status: 202, body: { ...current } };
  },
  retryRecordSync: (ctx) => {
    const u = me(ctx);
    const s = ownedSubdomain(u, ctx.params.name);
    const list = state.records.get(s.name) ?? [];
    const current = list.find((r) => r.id === ctx.params.recordId) ?? fail("NOT_FOUND");
    current.syncStatus = "pending";
    current.syncError = null;
    // 重試時不再模擬失敗
    if (current.type === "CNAME") current.target = current.target.replace("sync-error.", "");
    scheduleSync(s.name, current.id);
    return { status: 202, body: { ...current } };
  },
  planPreset: (ctx) => {
    const u = me(ctx);
    const s = ownedSubdomain(u, ctx.params.name);
    return { body: planPreset(ctx.params.presetId, ctx.body, s, u) };
  },
  applyPreset: (ctx) => {
    const u = me(ctx);
    const s = ownedSubdomain(u, ctx.params.name);
    return {
      status: 202,
      body: idempotent(ctx.c.req.header("idempotency-key"), `preset:${s.name}`, ctx.body, () => {
        requireActive(s);
        const plan = planPreset(ctx.params.presetId, ctx.body, s, u);
        const list = state.records.get(s.name) ?? [];
        const deletedIds = plan.deletes.map((r) => r.id);
        const remaining = list.filter((r) => !deletedIds.includes(r.id));
        if (remaining.length + plan.creates.length > recordQuota(u)) {
          fail("RECORD_QUOTA_EXCEEDED", `每個子網域最多 ${recordQuota(u)} 筆紀錄`);
        }
        const at = now();
        const created = plan.creates.map(
          (input) =>
            ({
              ...input,
              id: nextId("record"),
              fqdn: fqdnOf(input.name, s.name),
              version: 1,
              syncStatus: "pending",
              syncError: null,
              createdAt: at,
              updatedAt: at,
            }) as DnsRecord,
        );
        state.records.set(s.name, [...remaining, ...created]);
        refreshUsage(s.name);
        for (const r of created) scheduleSync(s.name, r.id);
        audit(
          "preset.apply",
          u,
          { type: "subdomain", id: s.name, label: s.fqdn },
          { preset: ctx.params.presetId },
          s.name,
        );
        return { created: created.map((r) => ({ ...r })), deletedIds };
      }),
    };
  },
  createTransfer: (ctx) => {
    const u = me(ctx);
    const s = ownedSubdomain(u, ctx.params.name);
    requireActive(s);
    const to = findUserByLogin(ctx.body.toGithubLogin);
    if (!to || to.id === u.id)
      fail("TRANSFER_RECIPIENT_NOT_FOUND", "找不到這個 GitHub 帳號的 Dev-in.tw 使用者");
    if (state.transfers.some((t) => t.subdomain === s.name && t.status === "pending")) {
      fail("TRANSFER_ALREADY_PENDING", "已經有一筆進行中的轉移");
    }
    const t: MockTransfer = {
      id: nextId("transfer"),
      subdomain: s.name,
      fromId: u.id,
      toId: (to as MockUser).id,
      status: "pending",
      keepRecords: ctx.body.keepRecords,
      createdAt: now(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      resolvedAt: null,
    };
    state.transfers.unshift(t);
    s.pendingTransferId = t.id;
    audit(
      "transfer.create",
      u,
      { type: "transfer", id: t.id, label: s.fqdn },
      { to: ctx.body.toGithubLogin },
      s.name,
    );
    emit(t.toId, { type: "transfer.updated", transferId: t.id, status: "pending" });
    return { status: 201, body: transferOut(t, ctx.origin) };
  },
  listTransfers: (ctx) => {
    const u = me(ctx);
    return {
      body: {
        incoming: state.transfers
          .filter((t) => t.toId === u.id)
          .map((t) => transferOut(t, ctx.origin)),
        outgoing: state.transfers
          .filter((t) => t.fromId === u.id)
          .map((t) => transferOut(t, ctx.origin)),
      },
    };
  },
  acceptTransfer: (ctx) => resolveTransfer(ctx, "accepted"),
  declineTransfer: (ctx) => resolveTransfer(ctx, "declined"),
  cancelTransfer: (ctx) => resolveTransfer(ctx, "cancelled"),

  adminOverview: () => ({
    body: {
      pendingReview: state.subdomains.filter((s) => s.status === "pending_review").length,
      openReports: state.reports.filter((r) => r.status === "open").length,
      failedSyncs: [...state.records.values()].flat().filter((r) => r.syncStatus === "error")
        .length,
      zone: { used: zoneUsed(), limit: LIMITS.zoneRecords },
      users: state.users.length + 80,
      subdomains: state.subdomains.length + 100,
    },
  }),
  adminListUsers: ({ query, origin }) => {
    const q = query.q?.toLowerCase();
    const items = state.users
      .filter((u) => !q || u.githubLogin.toLowerCase().includes(q))
      .filter((u) => !query.status || u.status === query.status)
      .map((u) => adminUserOut(u, origin));
    return { body: paged(items, query.limit, query.cursor) };
  },
  adminUpdateUser: (ctx) => {
    const target = findUser(ctx.params.userId) ?? fail("NOT_FOUND");
    if (ctx.body.status) {
      target.status = ctx.body.status;
      target.suspendedReason = ctx.body.status === "suspended" ? (ctx.body.reason ?? null) : null;
      if (ctx.body.status === "suspended") {
        state.sessions = state.sessions.filter((s) => s.userId !== target.id);
      }
    }
    if (ctx.body.quotaOverride !== undefined) target.quotaOverride = ctx.body.quotaOverride;
    audit(
      "user.update",
      ctx.user,
      { type: "user", id: target.id, label: target.githubLogin },
      { ...ctx.body },
    );
    return { body: adminUserOut(target, ctx.origin) };
  },
  adminListSubdomains: ({ query, origin }) => {
    const q = query.q?.toLowerCase();
    const items = state.subdomains
      .filter((s) => !q || s.name.includes(q))
      .filter((s) => !query.status || s.status === query.status)
      .map((s) => adminSubOut(s, origin));
    return { body: paged(items, query.limit, query.cursor) };
  },
  adminApproveSubdomain: (ctx) => {
    const s = adminSubdomain(ctx.params.name);
    if (s.status !== "pending_review") fail("SUBDOMAIN_NOT_ACTIVE", "這個子網域不在審核中");
    s.status = "active";
    s.activatedAt = now();
    s.reviewReasons = [];
    audit(
      "subdomain.approve",
      ctx.user,
      { type: "subdomain", id: s.name, label: s.fqdn },
      {},
      s.name,
    );
    emit(s.ownerId, { type: "subdomain.status", subdomain: s.name, status: "active" });
    return { body: adminSubOut(s, ctx.origin) };
  },
  adminRejectSubdomain: (ctx) => {
    const s = adminSubdomain(ctx.params.name);
    s.status = "releasing";
    audit(
      "subdomain.reject",
      ctx.user,
      { type: "subdomain", id: s.name, label: s.fqdn },
      { reason: ctx.body.reason },
      s.name,
    );
    emit(s.ownerId, { type: "subdomain.status", subdomain: s.name, status: "releasing" });
    const out = adminSubOut(s, ctx.origin);
    state.subdomains = state.subdomains.filter((x) => x.name !== s.name);
    return { body: out };
  },
  adminSuspendSubdomain: (ctx) => {
    const s = adminSubdomain(ctx.params.name);
    s.status = "suspended";
    s.suspendedReason = ctx.body.reason;
    audit(
      "subdomain.suspend",
      ctx.user,
      { type: "subdomain", id: s.name, label: s.fqdn },
      { reason: ctx.body.reason },
      s.name,
    );
    emit(s.ownerId, { type: "subdomain.status", subdomain: s.name, status: "suspended" });
    return { body: adminSubOut(s, ctx.origin) };
  },
  adminUnsuspendSubdomain: (ctx) => {
    const s = adminSubdomain(ctx.params.name);
    s.status = "active";
    s.suspendedReason = null;
    audit(
      "subdomain.unsuspend",
      ctx.user,
      { type: "subdomain", id: s.name, label: s.fqdn },
      {},
      s.name,
    );
    emit(s.ownerId, { type: "subdomain.status", subdomain: s.name, status: "active" });
    return { body: adminSubOut(s, ctx.origin) };
  },
  adminListReports: ({ query }) => {
    const items = state.reports.filter((r) => !query.status || r.status === query.status);
    return { body: paged(items, query.limit, query.cursor) };
  },
  adminResolveReport: (ctx) => {
    const r = state.reports.find((x) => x.id === ctx.params.reportId) ?? fail("NOT_FOUND");
    r.status = ctx.body.status;
    r.resolutionNote = ctx.body.resolutionNote;
    r.resolvedAt = now();
    r.handledBy = ctx.user ? publicUser(ctx.user, ctx.origin) : null;
    if (ctx.body.suspendSubdomain) {
      const s = state.subdomains.find((x) => x.name === r.subdomain);
      if (s) {
        s.status = "suspended";
        s.suspendedReason = ctx.body.resolutionNote || "檢舉成立";
      }
    }
    audit(
      "report.resolve",
      ctx.user,
      { type: "report", id: r.id, label: r.subdomain },
      { status: r.status },
    );
    return { body: { ...r } };
  },
  adminListReserved: ({ query }) => {
    const q = query.q?.toLowerCase();
    const items = state.reserved
      .filter((r) => !q || r.name.includes(q))
      .filter((r) => !query.category || r.category === query.category);
    return { body: paged(items, query.limit, query.cursor) };
  },
  adminAddReserved: (ctx) => {
    if (state.reserved.some((r) => r.name === ctx.body.name)) {
      fail("VALIDATION_FAILED", "已經在保留清單裡", [
        { path: "name", code: "DUPLICATE", message: "已存在" },
      ]);
    }
    const item = {
      name: ctx.body.name,
      category: ctx.body.category,
      note: ctx.body.note ?? null,
      createdBy: ctx.user ? publicUser(ctx.user, ctx.origin) : null,
      createdAt: now(),
    };
    state.reserved.unshift(item);
    audit("reserved.add", ctx.user, { type: "reserved", id: item.name, label: item.name });
    return { status: 201, body: item };
  },
  adminRemoveReserved: (ctx) => {
    if (!state.reserved.some((r) => r.name === ctx.params.name)) fail("NOT_FOUND");
    state.reserved = state.reserved.filter((r) => r.name !== ctx.params.name);
    audit("reserved.remove", ctx.user, {
      type: "reserved",
      id: ctx.params.name,
      label: ctx.params.name,
    });
    return ctx.c.body(null, 204);
  },
  adminAuditLog: ({ query, origin }) => {
    const items = state.audit
      .filter((e) => !query.action || e.action.startsWith(query.action))
      .filter((e) => !query.targetType || e.target.type === query.targetType)
      .map((e) => auditOut(e, origin));
    return { body: paged(items, query.limit, query.cursor) };
  },
  adminZone: () => ({
    body: {
      ...responses.adminZone,
      usage: { used: zoneUsed(), limit: LIMITS.zoneRecords },
      drift: responses.adminZone.drift.map((d) => ({ ...d })),
      deadJobs: state.deadJobs.map((d) => ({ ...d })),
    },
  }),
  adminRetrySyncJob: (ctx) => {
    const id = Number(ctx.params.jobId);
    if (!state.deadJobs.some((j) => j.id === id)) fail("NOT_FOUND", "找不到這個 dead 工作");
    state.deadJobs = state.deadJobs.filter((j) => j.id !== id);
    audit("sync_job.retry", ctx.user, { type: "sync_job", id: String(id), label: `#${id}` });
    return ctx.c.body(null, 204);
  },
  adminReconcile: (ctx) => {
    audit(
      "zone.reconcile",
      ctx.user,
      { type: "zone", id: ROOT_DOMAIN, label: ROOT_DOMAIN },
      { force: ctx.query.force },
    );
    return ctx.c.body(null, 202);
  },
  adminGetSettings: () => ({ body: { ...state.settings } }),
  adminUpdateSettings: (ctx) => {
    Object.assign(state.settings, ctx.body);
    audit(
      "settings.update",
      ctx.user,
      { type: "settings", id: "global", label: "settings" },
      { ...ctx.body },
    );
    return { body: { ...state.settings } };
  },
};

function resolveTransfer(
  ctx: Ctx<"acceptTransfer" | "declineTransfer" | "cancelTransfer">,
  status: "accepted" | "declined" | "cancelled",
): { body: Transfer } {
  const u = me(ctx);
  const t = state.transfers.find((x) => x.id === ctx.params.transferId) ?? fail("NOT_FOUND");
  const allowed = status === "cancelled" ? t.fromId === u.id : t.toId === u.id;
  if (!allowed) fail("NOT_FOUND");
  if (t.status !== "pending") fail("TRANSFER_INVALID_STATE", "這筆轉移已經結束");
  const s = state.subdomains.find((x) => x.name === t.subdomain);
  if (status === "accepted") {
    const owned = state.subdomains.filter((x) => x.ownerId === u.id).length;
    if (owned >= subdomainQuota(u)) fail("TRANSFER_RECIPIENT_QUOTA", "你的子網域數量已達上限");
    if (s) {
      s.ownerId = u.id;
      if (!t.keepRecords) state.records.set(s.name, []);
      refreshUsage(s.name);
    }
  }
  if (s) s.pendingTransferId = null;
  t.status = status;
  t.resolvedAt = now();
  audit(
    `transfer.${status === "accepted" ? "accept" : status === "declined" ? "decline" : "cancel"}`,
    u,
    {
      type: "transfer",
      id: t.id,
      label: t.subdomain,
    },
  );
  emit(t.fromId, { type: "transfer.updated", transferId: t.id, status });
  emit(t.toId, { type: "transfer.updated", transferId: t.id, status });
  return { body: transferOut(t, ctx.origin) };
}

function directory(origin: string) {
  return state.subdomains
    .filter((s) => s.status === "active" && s.showInDirectory)
    .sort(
      (a, b) => Date.parse(b.activatedAt ?? b.createdAt) - Date.parse(a.activatedAt ?? a.createdAt),
    )
    .map((s) => {
      const owner = findUser(s.ownerId);
      return {
        name: s.name,
        fqdn: s.fqdn,
        description: s.description,
        owner: owner
          ? publicUser(owner, origin)
          : { githubLogin: "ghost", displayName: null, avatarUrl: avatarUrl("ghost", origin) },
        since: s.activatedAt ?? s.createdAt,
      };
    });
}

function fqdnOf(name: string, sub: string): string {
  return name === "@" ? `${sub}.${ROOT_DOMAIN}` : `${name}.${sub}.${ROOT_DOMAIN}`;
}

function assertRules(input: RecordInput, s: MockSubdomain, list: DnsRecord[], u: MockUser) {
  const owned = state.subdomains.filter((x) => x.ownerId === u.id).map((x) => x.name);
  const problem = checkRecord(input, s.name, list, owned);
  if (problem) fail(problem.code, problem.detail, problem.errors);
}

function safeRedirect(raw: string | undefined): string {
  if (!raw?.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.length > 200) {
    return "/dashboard";
  }
  return raw;
}

function loginAs(login: string, role: "user" | "admin", ageDays: number): MockUser {
  const existing = findUserByLogin(login);
  if (existing) return existing;
  const at = now();
  const user: MockUser = {
    id: nextId("user"),
    githubId: 3_000_000 + state.seq,
    githubLogin: login,
    displayName: null,
    email: `${login.toLowerCase()}@example.com`,
    role,
    status: "active",
    suspendedReason: null,
    githubCreatedAt: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
    createdAt: at,
    lastLoginAt: at,
    quotaOverride: null,
    // dev 登入與假的 GitHub 授權頁都經過登入頁的同意說明，視同首次登入時同意目前版本
    consent: { ...CURRENT_LEGAL_VERSIONS, acceptedAt: at },
  };
  state.users.push(user);
  return user;
}

function planPreset(
  presetId: PresetId,
  body: { recordName: string; params: Record<string, string> },
  s: MockSubdomain,
  u: MockUser,
): ResponseOf<"planPreset"> {
  const result = planPresetRules(presetId, body.params, {
    sub: s.name,
    root: ROOT_DOMAIN,
    recordName: body.recordName,
    githubLogin: u.githubLogin,
    existing: (state.records.get(s.name) ?? []).filter((r) => r.syncStatus !== "deleting"),
  });
  if ("ok" in result) {
    const violations = result.ok ? [] : result.violations;
    return fail(
      "PRESET_PARAMS_INVALID",
      violations[0]?.message ?? "一鍵設定的參數不正確",
      violations,
    );
  }
  return {
    creates: result.creates,
    deletes: result.deletes.map((r) => ({ ...r })),
    warnings: result.warnings,
  };
}

const RESOLVERS = [
  { id: "cloudflare", label: "Cloudflare 1.1.1.1", delay: 0, latency: 18 },
  { id: "google", label: "Google 8.8.8.8", delay: 2000, latency: 31 },
  { id: "quad9", label: "Quad9 9.9.9.9", delay: 4000, latency: 54 },
  { id: "quad101", label: "TWNIC Quad101", delay: 6000, latency: 12 },
] as const;

function propagation(s: MockSubdomain, recordName: string, type: DnsRecord["type"]): Propagation {
  const list = (state.records.get(s.name) ?? []).filter(
    (r) => r.name === recordName && r.type === type && r.syncStatus !== "deleting",
  );
  const expected = list.map((r) => {
    const value = dataOf(r);
    return r.type === "CNAME" || r.type === "MX" ? `${value}.` : value;
  });
  // 尚無紀錄時以子網域建立時間為準，讓票券的傳播環也有進度可看
  const base = list.length
    ? Math.max(
        ...list.map((r) =>
          r.syncStatus === "synced" ? (syncedAt.get(r.id) ?? 0) : Date.now() + 1e9,
        ),
      )
    : Date.parse(s.createdAt);
  const elapsed = Date.now() - base;
  return {
    fqdn: fqdnOf(recordName, s.name),
    type,
    expected,
    resolvers: RESOLVERS.map((r) => {
      const seen = elapsed >= r.delay;
      return {
        id: r.id,
        label: r.label,
        answers: seen ? expected : [],
        matches: seen,
        latencyMs: r.latency,
        error: null,
      };
    }),
    checkedAt: now(),
  };
}

/* ---------------- app ---------------- */

function toHonoPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ":$1");
}

function issuesOf(error: z.ZodError, prefix = ""): FieldIssue[] {
  return error.issues.map((i) => ({
    path: [prefix, ...i.path.map(String)].filter(Boolean).join("."),
    code: i.code.toUpperCase(),
    message: i.message,
  }));
}

async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return fail("VALIDATION_FAILED", "body 必須是 JSON");
  }
}

function csrf(c: Context) {
  const origin = c.req.header("origin");
  if (!origin || origin !== originOf(c)) fail("CSRF_REJECTED");
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin") fail("CSRF_REJECTED");
}

export function createMockApp(): Hono {
  const app = new Hono();

  app.get("/api/healthz", (c) => c.json({ ok: true, db: "ok" }));
  app.get("/api/readyz", (c) => c.json({ ok: true }));

  app.post("/api/__mock/reset", (c) => {
    resetState();
    return c.json({ ok: true });
  });
  app.post("/api/__mock/config", async (c) => {
    const body = (await c.req.json()) as Partial<typeof state.config> & {
      registrationOpen?: boolean;
    };
    if (body.notImplemented) state.config.notImplemented = body.notImplemented;
    if (body.capacityFull !== undefined) state.config.capacityFull = body.capacityFull;
    if (body.syncDelayMs !== undefined) state.config.syncDelayMs = body.syncDelayMs;
    if (body.registrationOpen !== undefined)
      state.settings.registrationOpen = body.registrationOpen;
    return c.json(state.config);
  });
  // 測試用：把某個使用者的同意紀錄改成舊版（模擬條款改版）或清掉（從未同意）
  app.post("/api/__mock/consent", async (c) => {
    const body = (await c.req.json()) as { login: string; stale?: boolean };
    const u = findUserByLogin(body.login);
    if (!u) return c.json({ ok: false }, 404);
    u.consent = body.stale
      ? { termsVersion: "0.9", privacyVersion: "0.9", acceptedAt: "2026-01-01T00:00:00.000Z" }
      : null;
    return c.json({ ok: true });
  });
  app.get("/api/__mock/avatar/:login", (c) => {
    const login = c.req.param("login");
    let h = 0;
    for (const ch of login) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = h % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 55% 45%)"/><text x="32" y="41" font-family="monospace" font-size="28" font-weight="700" text-anchor="middle" fill="#fff">${login.slice(0, 1).toUpperCase()}</text></svg>`;
    return c.body(svg, 200, { "content-type": "image/svg+xml", "cache-control": "max-age=3600" });
  });
  // 假的 GitHub 授權頁：讓「使用 GitHub 登入」按鈕的完整流程可以在本機與 e2e 走一遍
  app.get("/api/__mock/github", (c) => {
    const redirect = safeRedirect(c.req.query("redirect"));
    const option = (login: string, label: string) =>
      `<button name="login" value="${login}">${label}</button>`;
    return c.html(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mock GitHub 授權</title>
<style>body{font:16px/1.6 ui-monospace,monospace;max-width:28rem;margin:4rem auto;padding:0 1rem;background:#0d1117;color:#e6edf3}button{display:block;width:100%;margin:.5rem 0;padding:.75rem;font:inherit;background:#238636;color:#fff;border:0;border-radius:6px;cursor:pointer}input{width:100%;padding:.5rem;font:inherit}</style>
<h1>Mock GitHub</h1><p>這是本機 mock server 的假授權頁，正式環境會導向 github.com。</p>
<form method="post" action="/api/__mock/github/authorize"><input type="hidden" name="redirect" value="${redirect}">
${option("alice", "以 alice 授權（一般使用者）")}${option("HACO8888", "以 HACO8888 授權（管理員）")}${option("new-dev", "以 new-dev 授權（新帳號）")}
</form></html>`);
  });
  app.post("/api/__mock/github/authorize", async (c) => {
    const form = await c.req.parseBody();
    const login = String(form.login ?? "alice");
    const user = loginAs(login, login === "HACO8888" ? "admin" : "user", 365);
    if (user.status === "suspended") return c.redirect("/login?error=suspended", 303);
    const session = createSession(c, user);
    audit("auth.login", user, { type: "user", id: user.id, label: user.githubLogin });
    c.header("set-cookie", sessionCookie(session.token));
    return c.redirect(safeRedirect(String(form.redirect ?? "")), 303);
  });

  for (const name of Object.keys(endpoints) as EndpointName[]) {
    const ep = endpoints[name];
    const handler = handlers[name] as Handler<EndpointName>;
    app.on(ep.method, `/api/v1${toHonoPath(ep.path)}`, async (c) => {
      const instance = new URL(c.req.url).pathname;
      try {
        if (state.config.notImplemented.includes(name)) {
          fail("NOT_IMPLEMENTED", "這個功能即將推出");
        }
        const auth = currentSession(c);
        if (ep.auth !== "public" && !auth) fail("UNAUTHENTICATED");
        if (auth?.user.status === "suspended" && ep.auth !== "public") fail("ACCOUNT_SUSPENDED");
        if (ep.auth === "admin" && auth?.user.role !== "admin") fail("NOT_FOUND");
        if (ep.method !== "GET") csrf(c);

        const parse = <T>(schema: z.ZodType | undefined, value: unknown, prefix: string): T => {
          if (!schema) return undefined as T;
          const result = schema.safeParse(value);
          if (!result.success)
            fail("VALIDATION_FAILED", "欄位格式不正確", issuesOf(result.error, prefix));
          return (result as { data: T }).data;
        };
        const raw = "body" in ep ? await readJson(c) : undefined;
        const ctx: Ctx<EndpointName> = {
          c,
          origin: originOf(c),
          user: auth?.user ?? null,
          session: auth?.session ?? null,
          params: parse("params" in ep ? ep.params : undefined, c.req.param(), "params"),
          query: parse("query" in ep ? ep.query : undefined, c.req.query(), "query"),
          body: parse("body" in ep ? ep.body : undefined, raw, ""),
        } as Ctx<EndpointName>;

        const out = await handler(ctx);
        if (out instanceof Response) return out;
        if (ep.response) {
          const checked = ep.response.safeParse(out.body);
          if (!checked.success) {
            console.error(`[mock] ${name} response drifted from contract`, checked.error.issues);
            return problemResponse(c, problemBody("INTERNAL", instance, "mock 回應不符合合約"));
          }
        }
        return c.json(
          out.body as object,
          (out.status ?? ep.status) as 200,
          out.headers ? Object.fromEntries(out.headers) : undefined,
        );
      } catch (error) {
        if (error instanceof MockProblem) {
          return problemResponse(c, problemBody(error.code, instance, error.detail, error.errors));
        }
        console.error(`[mock] ${name} failed`, error);
        return problemResponse(c, problemBody("INTERNAL", instance));
      }
    });
  }

  app.all("/api/*", (c) =>
    problemResponse(c, problemBody("NOT_FOUND", new URL(c.req.url).pathname)),
  );

  return app;
}
