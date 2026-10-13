"use client";

import type { Me } from "@dit/contract";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { q } from "./queries.ts";

const MeContext = createContext<Me | null>(null);

/** Server layout 拿到的 /me 當作初始值，之後由 TanStack Query 維持新鮮 */
export function MeProvider({ me, children }: { me: Me; children: ReactNode }) {
  const { data } = useQuery({ ...q.me(), initialData: me, staleTime: 30_000 });
  return <MeContext value={data}>{children}</MeContext>;
}

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe must be used inside <MeProvider>");
  return me;
}
