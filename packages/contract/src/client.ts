import type { z } from "zod";
import type { Endpoint, EndpointName, Endpoints } from "./endpoints.ts";
import { endpoints } from "./endpoints.ts";
import { type ErrorCode, Problem, problemType } from "./errors.ts";

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;
type Part<E, K extends "params" | "query" | "body"> = E extends {
  [P in K]: infer S extends z.ZodType;
}
  ? z.input<S>
  : never;

export type RequestOf<N extends EndpointName> = {
  params?: Part<Endpoints[N], "params">;
  query?: Part<Endpoints[N], "query">;
  body?: Part<Endpoints[N], "body">;
  idempotencyKey?: string;
  ifMatch?: number;
  signal?: AbortSignal;
};
export type ResponseOf<N extends EndpointName> = Out<Endpoints[N]["response"]>;

export class ApiError extends Error {
  readonly problem: Problem; // 不用 parameter property：要符合 erasableSyntaxOnly（Node 原生 type stripping）
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

/** 等同 DOM 的 HeadersInit（不依賴 DOM lib，Node 與瀏覽器皆可用） */
export type HeadersInput = ConstructorParameters<typeof Headers>[0];

export interface ClientOptions {
  baseUrl: string; // 瀏覽器端用 "/api/v1"；RSC 用 `${API_INTERNAL_URL}/api/v1`
  fetch?: typeof fetch;
  headers?: () => HeadersInput | Promise<HeadersInput>; // RSC 用來轉發 cookie
  validateResponses?: boolean; // dev 與測試時為 true
}

export type Client = <N extends EndpointName>(
  name: N,
  req?: RequestOf<N>,
) => Promise<ResponseOf<N>>;

/** 把 `/subdomains/{name}` 這類路徑填入參數（每個值都會 encodeURIComponent）。缺參數時丟出 TypeError。 */
export function resolvePath(path: string, params: Record<string, unknown> | undefined): string {
  return path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params?.[key];
    if (value === undefined || value === null || value === "") {
      throw new TypeError(`missing path parameter "${key}" for ${path}`);
    }
    return encodeURIComponent(String(value));
  });
}

/** 把 query 物件序列化成 `?a=1&b=2`；undefined 與 null 會被略過，沒有任何值時回傳空字串。 */
export function serializeQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

const STATUS_FALLBACK_CODE: Partial<Record<number, ErrorCode>> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  412: "VERSION_CONFLICT",
  429: "RATE_LIMITED",
  501: "NOT_IMPLEMENTED",
};

/** 回應不是合法的 problem+json 時（例如 proxy 回的 502 HTML），合成一個 Problem，讓呼叫端只需要處理 ApiError。 */
function fallbackProblem(res: Response, instance: string): Problem {
  const status = res.status >= 400 && res.status <= 599 ? res.status : 500;
  const code = STATUS_FALLBACK_CODE[status] ?? "INTERNAL";
  const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  return {
    type: problemType(code),
    title: res.statusText || `HTTP ${res.status}`,
    status,
    code,
    instance,
    requestId: res.headers.get("x-request-id") ?? "",
    ...(Number.isInteger(retryAfter) ? { retryAfter } : {}),
  };
}

async function readProblem(res: Response, instance: string): Promise<Problem> {
  try {
    const parsed = Problem.safeParse(await res.json());
    if (parsed.success) return parsed.data;
  } catch {
    // body 不是 JSON，改用 fallback
  }
  return fallbackProblem(res, instance);
}

export function createClient(opts: ClientOptions): Client {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");

  return async function call<N extends EndpointName>(
    name: N,
    req: RequestOf<N> = {} as RequestOf<N>,
  ): Promise<ResponseOf<N>> {
    const ep: Endpoint = endpoints[name];
    const pathname = `${baseUrl}${resolvePath(ep.path, req.params as Record<string, unknown> | undefined)}`;
    const url = pathname + serializeQuery(req.query as Record<string, unknown> | undefined);

    const headers = new Headers(opts.headers ? await opts.headers() : undefined);
    headers.set("Accept", ep.response ? "application/json" : "*/*");
    const hasBody = req.body !== undefined;
    if (hasBody) headers.set("Content-Type", "application/json");
    if (req.idempotencyKey !== undefined) headers.set("Idempotency-Key", req.idempotencyKey);
    if (req.ifMatch !== undefined) headers.set("If-Match", `"${req.ifMatch}"`);

    const isRedirect = ep.status === 302 || ep.status === 303;
    const init: RequestInit = {
      method: ep.method,
      headers,
      credentials: "same-origin",
      redirect: isRedirect ? "manual" : "follow",
    };
    if (hasBody) init.body = JSON.stringify(req.body);
    if (req.signal) init.signal = req.signal;

    const res = await doFetch(url, init);

    const redirected = isRedirect && (res.type === "opaqueredirect" || res.status === ep.status);
    if (!res.ok && !redirected) {
      throw new ApiError(await readProblem(res, pathname));
    }

    if (ep.response === null) {
      // 204、redirect、SSE：不讀 body，避免串流一直開著
      await res.body?.cancel().catch(() => {});
      return undefined as ResponseOf<N>;
    }

    const json: unknown = await res.json();
    if (opts.validateResponses) {
      return ep.response.parse(json) as ResponseOf<N>;
    }
    return json as ResponseOf<N>;
  };
}
