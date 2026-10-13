/** fetch 加逾時（AbortSignal.timeout），所有對外呼叫都必須有逾時（PLAN §3.7、§3.8） */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string | URL,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  return fetchImpl(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
}
