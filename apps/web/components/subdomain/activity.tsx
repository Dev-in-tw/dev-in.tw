"use client";

import { useQuery } from "@tanstack/react-query";
import { ActivityList } from "@/components/app/activity.tsx";
import { isNotImplemented } from "@/lib/api/client.ts";
import { errorMessage } from "@/lib/errors.ts";
import { q } from "@/lib/queries.ts";

export function SubdomainActivity({ name }: { name: string }) {
  const { data, error, isPending } = useQuery(q.subdomainActivity(name));
  if (error && isNotImplemented(error)) return <p className="text-ink-muted">活動紀錄即將推出。</p>;
  if (error) return <p className="text-danger">{errorMessage(error)}</p>;
  if (isPending) return <p className="text-ink-muted">載入中…</p>;
  return <ActivityList items={data.items} className="max-w-2xl" />;
}
