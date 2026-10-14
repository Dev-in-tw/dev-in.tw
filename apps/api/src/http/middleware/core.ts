import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomToken } from "../../lib/crypto.ts";
import { hashIp, rateKeyForIp, resolveClientIp, resolveViaCloudflare } from "../../lib/net.ts";
import { AppError } from "../../lib/problem.ts";
import { effectiveRole, resolveSession, SESSION_COOKIE } from "../../modules/identity/sessions.ts";
import type { AppEnv } from "../env.ts";
import { type RateLimiter, RULES } from "./rate-limit.ts";

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** 沿用 Traefik 帶來的 X-Request-Id，沒有或格式不對就自己產生 */
export const requestId = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomToken(12);
  c.set("requestId", id);
  c.set("log", {});
  await next();
  c.header("X-Request-Id", id);
};

interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string } };
}

export const clientIp =
  (hops: number, trustCloudflare = false): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const env = c.env as NodeBindings | undefined;
    const proxied = resolveClientIp(
      c.req.header("x-forwarded-for"),
      env?.incoming?.socket?.remoteAddress,
      hops,
    );
    c.set(
      "clientIp",
      trustCloudflare ? resolveViaCloudflare(proxied, c.req.header("cf-connecting-ip")) : proxied,
    );
    await next();
  };

/** 每個請求只輸出一行（wide event，PLAN §3.11）。不記錄 cookie、token、OAuth code、email。 */
export const wideLog = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const started = performance.now();
  await next();
  const deps = c.get("deps");
  const log = c.get("log");
  const status = c.res.status;
  const line = {
    evt: "http",
    request_id: c.get("requestId"),
    method: c.req.method,
    route: c.req.routePath,
    status,
    duration_ms: Math.round(performance.now() - started),
    ip_hash: hashIp(c.get("clientIp"), deps.config.REPORT_IP_SALT)?.slice(0, 16) ?? null,
    ...log,
  };
  if (status >= 500) deps.logger.error(line, "request");
  else if (c.req.path.endsWith("/healthz") || c.req.path.endsWith("/readyz"))
    deps.logger.debug(line, "request");
  else deps.logger.info(line, "request");
};

export const securityHeaders = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("X-Frame-Options", "DENY");
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
};

/** 請求 body 上限：最大的合法 body（2,048 字元的 TXT、2,000 字的檢舉內容）都遠小於這個值 */
export const MAX_BODY_BYTES = 32 * 1024;

export const limitBody = (maxSize = MAX_BODY_BYTES): MiddlewareHandler<AppEnv> =>
  bodyLimit({
    maxSize,
    onError: () => {
      throw new AppError("VALIDATION_FAILED", "請求內容太大", {
        errors: [{ path: "(body)", code: "too_large", message: `body 不能超過 ${maxSize} bytes` }],
      });
    },
  });

/**
 * 解析 __Host-dit_session（同一個請求只查一次）。Bearer token（PAT）是 P2，目前忽略。
 * 角色每個請求都依 ADMIN_GITHUB_IDS 重算：被移出清單的管理員不必等到下次登入才失去權限。
 */
export const session = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const deps = c.get("deps");
  const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  const resolved = token ? await resolveSession(deps.db, token, deps.clock.now()) : null;
  if (resolved) {
    const role = effectiveRole(resolved.user, deps.config);
    if (role !== resolved.user.role) resolved.user = { ...resolved.user, role };
  }
  c.set("session", resolved);
  if (resolved) c.get("log").user_id = resolved.user.id;
  await next();
};

/**
 * 讀 cookie。同名 cookie 出現不只一次時視為不存在：`__Host-` 前綴已經擋掉子網域植入，但舊瀏覽器的
 * nameless cookie（`=__Host-x=v`）等繞過手法會讓 header 裡出現兩個同名值，這時寧可當作沒登入。
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    if (found !== undefined) return undefined;
    found = part.slice(index + 1).trim();
  }
  return found;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF（PLAN §3.7）：使用者子網域與 apex 同站，SameSite 擋不住，所以所有寫入請求都要求
 * Origin 完全等於 APP_ORIGIN、Sec-Fetch-Site（若有）是 same-origin、body 只接受 JSON。
 */
export const csrf =
  (appOrigin: string): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header("origin");
    if (!origin || origin !== appOrigin) {
      throw new AppError("CSRF_REJECTED", undefined, {
        errors: [{ path: "origin", code: "ORIGIN_MISMATCH", message: "Origin 不符" }],
      });
    }
    const site = c.req.header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin") {
      throw new AppError("CSRF_REJECTED", undefined, {
        errors: [{ path: "sec-fetch-site", code: "CROSS_SITE", message: "不接受跨站請求" }],
      });
    }
    const length = Number(c.req.header("content-length") ?? "0");
    const hasBody = length > 0 || c.req.header("transfer-encoding") !== undefined;
    if (hasBody) {
      const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") {
        throw new AppError("CSRF_REJECTED", "只接受 application/json", {
          errors: [
            { path: "content-type", code: "CONTENT_TYPE", message: "只接受 application/json" },
          ],
        });
      }
    }
    await next();
  };

export const globalRateLimit =
  (limiter: RateLimiter): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const result = limiter.take(RULES.global, rateKeyForIp(c.get("clientIp")));
    if (!result.ok) {
      c.get("log").rate_limited = true;
      throw new AppError("RATE_LIMITED", undefined, {
        retryAfter: result.retryAfter,
        headers: { "Retry-After": String(result.retryAfter) },
      });
    }
    await next();
  };
