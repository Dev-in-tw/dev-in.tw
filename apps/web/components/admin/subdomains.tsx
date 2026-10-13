"use client";

import type { AdminSubdomain, SubdomainStatus } from "@dit/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useDeferredValue, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/app/avatar.tsx";
import { SubdomainBadge } from "@/components/app/status-badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input, Select } from "@/components/ui/field.tsx";
import { api } from "@/lib/api/client.ts";
import { errorMessage } from "@/lib/errors.ts";
import { formatDate } from "@/lib/time.ts";
import { DataTable, ListState, useAdminList } from "./common.tsx";
import { ReasonDialog } from "./reason-dialog.tsx";

export function AdminSubdomains() {
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [status, setStatus] = useState<SubdomainStatus | "">("");
  const q = useDeferredValue(search.trim().toLowerCase());
  const list = useAdminList("adminListSubdomains", {
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
  });
  const items = (list.data?.pages.flatMap((p) => p.items) ?? []) as AdminSubdomain[];
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<{
    sub: AdminSubdomain;
    kind: "suspend" | "unsuspend";
  } | null>(null);
  const act = useMutation({
    mutationFn: ({
      sub,
      kind,
      reason,
    }: {
      sub: AdminSubdomain;
      kind: "suspend" | "unsuspend";
      reason: string;
    }) =>
      kind === "suspend"
        ? api("adminSuspendSubdomain", { params: { name: sub.name }, body: { reason } })
        : api("adminUnsuspendSubdomain", {
            params: { name: sub.name },
            body: reason ? { reason } : {},
          }),
    onSuccess: (s) => {
      toast.success(s.status === "suspended" ? `已停權 ${s.fqdn}` : `已解除 ${s.fqdn} 的停權`);
      setTarget(null);
      queryClient.invalidateQueries({ queryKey: ["adminListSubdomains"] });
    },
  });

  return (
    <div>
      <h1 className="text-step-3 font-semibold tracking-tight">子網域</h1>
      <div className="mt-5 flex flex-wrap gap-3">
        <label htmlFor="sub-search" className="sr-only">
          搜尋子網域
        </label>
        <Input
          id="sub-search"
          data-search
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜尋名稱（按 / 聚焦）"
          className="zone max-w-xs"
        />
        <label htmlFor="sub-status" className="sr-only">
          狀態
        </label>
        <Select
          id="sub-status"
          value={status}
          onChange={(e) => setStatus(e.target.value as SubdomainStatus | "")}
          className="w-40"
        >
          <option value="">所有狀態</option>
          <option value="active">啟用中</option>
          <option value="pending_review">審核中</option>
          <option value="suspended">已停權</option>
          <option value="releasing">釋出中</option>
        </Select>
      </div>
      <div className="mt-5">
        <ListState query={list} empty={items.length === 0}>
          <DataTable label="子網域清單" head={["名稱", "狀態", "擁有者", "紀錄", "建立", ""]}>
            {items.map((s) => (
              <tr key={s.name} className="hover:bg-surface">
                <td className="zone px-3 py-2.5 font-medium">{s.fqdn}</td>
                <td className="px-3 py-2.5">
                  <SubdomainBadge status={s.status} />
                </td>
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-2">
                    <Avatar src={s.owner.avatarUrl} login={s.owner.githubLogin} size={20} />
                    <span className="zone">@{s.owner.githubLogin}</span>
                  </span>
                </td>
                <td className="zone px-3 py-2.5">
                  {s.records.used}/{s.records.limit}
                </td>
                <td className="zone px-3 py-2.5 text-ink-muted">{formatDate(s.createdAt)}</td>
                <td className="px-3 py-2.5 text-right">
                  {s.status === "suspended" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setTarget({ sub: s, kind: "unsuspend" })}
                    >
                      解除停權
                    </Button>
                  ) : s.status === "active" ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setTarget({ sub: s, kind: "suspend" })}
                    >
                      停權
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </DataTable>
        </ListState>
      </div>
      <ReasonDialog
        open={Boolean(target)}
        onOpenChange={(v) => !v && setTarget(null)}
        title={
          target?.kind === "suspend"
            ? `停權 ${target.sub.fqdn}`
            : `解除 ${target?.sub.fqdn ?? ""} 的停權`
        }
        description={
          target?.kind === "suspend"
            ? "Cloudflare 上的紀錄會撤下，資料庫保留；解除時會重新同步。"
            : "紀錄會重新同步到 Cloudflare。"
        }
        confirmLabel={target?.kind === "suspend" ? "停權" : "解除停權"}
        required={target?.kind === "suspend"}
        danger={target?.kind === "suspend"}
        pending={act.isPending}
        error={act.isError ? errorMessage(act.error) : null}
        onSubmit={(reason) => target && act.mutate({ ...target, reason })}
      />
    </div>
  );
}
