import {
  type Endpoint,
  type EndpointName,
  type Endpoints,
  endpoints,
  type FieldIssue,
} from "@dit/contract";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { z } from "zod";
import type { Actor } from "../context.ts";
import { idempotencyKeys, type SessionRow, type UserRow } from "../db/schema.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { AppError } from "../lib/problem.ts";
import { type AppContext, type AppEnv, actorOf } from "./env.ts";
import type { RateLimiter, RateRule } from "./middleware/rate-limit.ts";

type Part<E, K extends "params" | "query" | "body"> = E extends {
  [P in K]: infer S extends z.ZodType;
}
  ? z.output<S>
  : undefined;
type Out<T> = T extends z.ZodType ? z.output<T> : Response;

type AuthOf<N extends EndpointName> = Endpoints[N]["auth"];

export interface HandlerInput<N extends EndpointName> {
  c: AppContext;
  params: Part<Endpoints[N], "params">;
  query: Part<Endpoints[N], "query">;
  body: Part<Endpoints[N], "body">;
  user: AuthOf<N> extends "public" ? UserRow | null : UserRow;
  session: AuthOf<N> extends "public" ? SessionRow | null : SessionRow;
  actor: Actor;
  /** If-Match: "<version>"；沒帶時為 null */
  ifMatch: number | null;
}

export type Handler<N extends EndpointName> = (
  input: HandlerInput<N>,
) => Promise<Out<Endpoints[N]["response"]> | Response>;

export interface RouteOptions {
  rateLimits?: readonly RateRule[];
  /** 停權中的帳號也能呼叫（例如登出） */
  allowSuspended?: boolean;
  /** 進入 zod 驗證前的正規化（PLAN §5.3：小寫、去掉結尾的點；前端送出前也會做） */
  normalizeBody?: (raw: unknown) => unknown;
}

export const toHonoPath = (path: string): string => `/v1${path.replace(/\{(\w+)\}/g, ":$1")}`;

function zodIssues(error: z.ZodError, prefix?: string): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].filter(Boolean).join(".") || "(root)",
    code: issue.code,
    message: issue.message,
  }));
}

function parseIfMatch(header: string | undefined): number | null {
  if (header === undefined) return null;
  const match = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(header);
  if (!match?.[1])
    throw new AppError("VALIDATION_FAILED", "If-Match 格式不正確", {
      errors: [{ path: "If-Match", code: "invalid", message: 'If-Match 必須是 "<version>"' }],
    });
  return Number(match[1]);
}

async function readJson(c: AppContext): Promise<{ raw: string; value: unknown }> {
  const raw = await c.req.text();
  if (raw.trim() === "") return { raw, value: undefined };
  try {
    return { raw, value: JSON.parse(raw) };
  } catch {
    throw new AppError("VALIDATION_FAILED", "請求內容不是合法的 JSON", {
      errors: [{ path: "(body)", code: "invalid_json", message: "JSON 解析失敗" }],
    });
  }
}

export interface Registry {
  app: Hono<AppEnv>;
  limiter: RateLimiter;
  validateResponses: boolean;
  /** 已註冊的端點（合約一致性測試用） */
  registered: Set<EndpointName>;
}

/**
 * 依合約的 endpoint map 註冊路由：路徑、方法、狀態碼都來自合約，params / query / body 以合約的 zod
 * schema 驗證，回應在非 production 時再用 response schema 檢查一次（合約漂移會直接變成 500）。
 */
export function define<N extends EndpointName>(
  reg: Registry,
  name: N,
  handler: Handler<N>,
  options: RouteOptions = {},
): void {
  const ep: Endpoint = endpoints[name];
  const method = ep.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
  reg.registered.add(name);

  reg.app.on(ep.method, toHonoPath(ep.path), async (c) => {
    const deps = c.get("deps");
    const resolved = c.get("session");

    // 權限：admin 端點對非 admin（含未登入）一律 404，不透露存在與否
    if (ep.auth === "admin" && resolved?.user.role !== "admin") throw new AppError("NOT_FOUND");
    if (ep.auth !== "public" && !resolved) throw new AppError("UNAUTHENTICATED");
    if (ep.auth !== "public" && resolved?.user.status === "suspended" && !options.allowSuspended) {
      throw new AppError("ACCOUNT_SUSPENDED", resolved.user.suspendedReason ?? undefined);
    }

    let params: unknown;
    if (ep.params) {
      const parsed = ep.params.safeParse(c.req.param());
      // 路徑參數不合法時，資源不可能存在：回 404 而不是 400
      if (!parsed.success) throw new AppError("NOT_FOUND");
      params = parsed.data;
      const sub = (parsed.data as { name?: string }).name;
      if (sub && ep.path.startsWith("/subdomains")) c.get("log").subdomain = sub;
    }
    let query: unknown;
    if (ep.query) {
      const parsed = ep.query.safeParse(c.req.query());
      if (!parsed.success)
        throw new AppError("VALIDATION_FAILED", undefined, {
          errors: zodIssues(parsed.error, "query"),
        });
      query = parsed.data;
    }
    let body: unknown;
    let rawBody = "";
    if (ep.body) {
      const json = await readJson(c);
      rawBody = json.raw;
      const value = json.value ?? {};
      const parsed = ep.body.safeParse(
        options.normalizeBody ? options.normalizeBody(value) : value,
      );
      if (!parsed.success)
        throw new AppError("VALIDATION_FAILED", undefined, { errors: zodIssues(parsed.error) });
      body = parsed.data;
    }
    const ifMatch = ep.headers?.includes("If-Match")
      ? parseIfMatch(c.req.header("if-match"))
      : null;

    for (const rule of options.rateLimits ?? []) {
      const key =
        rule.by === "user"
          ? (resolved?.user.id ?? c.get("clientIp") ?? "anon")
          : (c.get("clientIp") ?? "unknown");
      const result = reg.limiter.take(rule, key);
      if (!result.ok) {
        c.get("log").rate_limited = true;
        throw new AppError("RATE_LIMITED", undefined, {
          retryAfter: result.retryAfter,
          headers: { "Retry-After": String(result.retryAfter) },
        });
      }
    }

    const input = {
      c,
      params,
      query,
      body,
      user: resolved?.user ?? null,
      session: resolved?.session ?? null,
      actor: actorOf(c, ep.auth === "admin" ? "admin" : "user"),
      ifMatch,
    } as HandlerInput<N>;

    const run = async (): Promise<Response> => {
      const result = await handler(input);
      if (result instanceof Response) return result;
      if (reg.validateResponses && ep.response) {
        const check = ep.response.safeParse(result);
        if (!check.success) {
          deps.logger.error(
            { endpoint: name, issues: check.error.issues },
            "response does not match the contract",
          );
          throw new Error(`response for ${name} does not match the contract`);
        }
      }
      return c.json(result as object, ep.status as 200);
    };

    const idemKey = ep.headers?.includes("Idempotency-Key")
      ? c.req.header("idempotency-key")
      : undefined;
    if (idemKey === undefined || !resolved) return run();
    return withIdempotency(c, resolved.user.id, idemKey, `${method} ${c.req.path} ${rawBody}`, run);
  });
}

/**
 * Idempotency-Key（PLAN §3.6）：同一個 key 重送時回放第一次的回應；body 不同時回 422。
 * 先插入佔位列（status 0）避免併發的兩個請求都執行；失敗時刪掉佔位，讓使用者可以重試。
 */
async function withIdempotency(
  c: AppContext,
  userId: string,
  key: string,
  fingerprint: string,
  run: () => Promise<Response>,
): Promise<Response> {
  const { db } = c.get("deps");
  if (key.length < 8 || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new AppError("VALIDATION_FAILED", "Idempotency-Key 格式不正確", {
      errors: [
        {
          path: "Idempotency-Key",
          code: "invalid",
          message: "必須是 8–200 個可列印字元（建議 UUID）",
        },
      ],
    });
  }
  const hash = sha256Hex(fingerprint);
  const inserted = await db
    .insert(idempotencyKeys)
    .values({ userId, key, requestHash: hash, responseStatus: 0, responseBody: null })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length === 0) {
    const [existing] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    if (!existing || existing.requestHash !== hash) {
      throw new AppError("IDEMPOTENCY_KEY_REUSED", "這個 Idempotency-Key 已用在不同的請求");
    }
    if (existing.responseStatus === 0) {
      throw new AppError("IDEMPOTENCY_KEY_REUSED", "相同 Idempotency-Key 的請求仍在處理中");
    }
    c.header("Idempotent-Replayed", "true");
    return c.json(existing.responseBody as object, existing.responseStatus as 200);
  }
  try {
    const response = await run();
    const text = await response.clone().text();
    await db
      .update(idempotencyKeys)
      .set({ responseStatus: response.status, responseBody: text ? JSON.parse(text) : null })
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    return response;
  } catch (error) {
    await db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    throw error;
  }
}
