import type { EndpointName, ErrorCode, Problem, RequestOf, ResponseOf } from "@dit/contract";
import { NO_BODY, routes } from "./routes.ts";

/** 與合約的 ApiError 同形：前端只依 `code` 判斷邏輯，不解析 `detail` */
export class ApiError extends Error {
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
    this.problem = problem;
  }
  get code(): ErrorCode {
    return this.problem.code;
  }
  get status(): number {
    return this.problem.status;
  }
}

export function isApiError(error: unknown, code?: ErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

/** P1 端點尚未實作時回 501；呼叫端據此隱藏入口或顯示「即將推出」 */
export function isNotImplemented(error: unknown): boolean {
  return isApiError(error, "NOT_IMPLEMENTED");
}

export function fillPath(path: string, params: Record<string, unknown> | undefined): string {
  return path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params?.[key];
    if (value === undefined || value === null || value === "") {
      throw new TypeError(`missing path parameter "${key}" for ${path}`);
    }
    return encodeURIComponent(String(value));
  });
}

export function toQueryString(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    search.append(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

const FALLBACK: Partial<Record<number, ErrorCode>> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  412: "VERSION_CONFLICT",
  429: "RATE_LIMITED",
  501: "NOT_IMPLEMENTED",
};

async function readProblem(res: Response, instance: string): Promise<Problem> {
  try {
    const body = (await res.json()) as Partial<Problem>;
    if (body && typeof body.code === "string" && typeof body.status === "number") {
      return body as Problem;
    }
  } catch {
    // body 不是 JSON（例如 proxy 回的 502 HTML），改用 fallback
  }
  const status = res.status >= 400 && res.status <= 599 ? res.status : 500;
  const code = FALLBACK[status] ?? "INTERNAL";
  const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  return {
    type: `https://dev-in.tw/problems/${code.toLowerCase().replaceAll("_", "-")}`,
    title: res.statusText || `HTTP ${res.status}`,
    status,
    code,
    instance,
    requestId: res.headers.get("x-request-id") ?? "",
    ...(Number.isInteger(retryAfter) ? { retryAfter } : {}),
  };
}

export interface WebClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export type WebClient = <N extends EndpointName>(
  name: N,
  req?: RequestOf<N>,
) => Promise<ResponseOf<N>>;

export function createWebClient(opts: WebClientOptions = {}): WebClient {
  const baseUrl = (opts.baseUrl ?? "/api/v1").replace(/\/+$/, "");
  return async function call<N extends EndpointName>(name: N, req: RequestOf<N> = {}) {
    const [method, path] = routes[name];
    const pathname = `${baseUrl}${fillPath(path, req.params as Record<string, unknown>)}`;
    const url = pathname + toQueryString(req.query as Record<string, unknown>);
    const headers = new Headers({ Accept: NO_BODY.has(name) ? "*/*" : "application/json" });
    const hasBody = req.body !== undefined;
    if (hasBody) headers.set("Content-Type", "application/json");
    if (req.idempotencyKey) headers.set("Idempotency-Key", req.idempotencyKey);
    if (req.ifMatch !== undefined) headers.set("If-Match", `"${req.ifMatch}"`);
    const init: RequestInit = { method, headers, credentials: "same-origin" };
    if (hasBody) init.body = JSON.stringify(req.body);
    if (req.signal) init.signal = req.signal;

    const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    const res = await doFetch(url, init);
    if (!res.ok) throw new ApiError(await readProblem(res, pathname));
    if (NO_BODY.has(name) || res.status === 204) {
      await res.body?.cancel().catch(() => {});
      return undefined as ResponseOf<N>;
    }
    return (await res.json()) as ResponseOf<N>;
  };
}

/** 瀏覽器端單例：同源 /api/v1 */
export const api = createWebClient();

export function idempotencyKey(): string {
  return crypto.randomUUID();
}
