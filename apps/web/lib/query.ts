import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "./api/client.ts";

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // 4xx（含 501 NOT_IMPLEMENTED）重試沒有意義
        retry: (count, error) => {
          if (isApiError(error) && error.status < 500) return false;
          if (isApiError(error, "NOT_IMPLEMENTED")) return false;
          return count < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}
