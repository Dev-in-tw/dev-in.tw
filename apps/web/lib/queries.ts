"use client";

import type { EndpointName, RequestOf, ResponseOf } from "@dit/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./api/client.ts";

/** query key = [endpoint 名稱, 參數]，與 PLAN §5.4 一致 */
export function endpointKey<N extends EndpointName>(name: N, req?: RequestOf<N>) {
  return [name, req?.params ?? null, req?.query ?? null] as const;
}

export function endpointQuery<N extends EndpointName>(name: N, req?: RequestOf<N>) {
  return queryOptions<ResponseOf<N>>({
    queryKey: endpointKey(name, req),
    queryFn: ({ signal }) => api(name, { ...req, signal } as RequestOf<N>),
  });
}

export const q = {
  meta: () => ({ ...endpointQuery("getMeta"), staleTime: 5 * 60_000 }),
  stats: () => ({ ...endpointQuery("getStats"), staleTime: 60_000 }),
  status: () => ({ ...endpointQuery("getStatus"), refetchInterval: 30_000 }),
  directory: (limit = 100) => endpointQuery("listDirectory", { query: { limit } }),
  presets: () => ({ ...endpointQuery("listPresets"), staleTime: 5 * 60_000 }),
  me: () => endpointQuery("getMe"),
  subdomains: () => endpointQuery("listSubdomains"),
  subdomain: (name: string) => endpointQuery("getSubdomain", { params: { name } }),
  records: (name: string) => endpointQuery("listRecords", { params: { name } }),
  transfers: () => endpointQuery("listTransfers"),
  sessions: () => endpointQuery("listSessions"),
  myActivity: () => endpointQuery("listMyActivity", { query: { limit: 30 } }),
  subdomainActivity: (name: string) =>
    endpointQuery("listSubdomainActivity", { params: { name }, query: { limit: 50 } }),
};
