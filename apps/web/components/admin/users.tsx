"use client";

import type { AdminUser, UserStatus } from "@dit/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useId, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/app/avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent } from "@/components/ui/dialog.tsx";
import { FieldError, Input, Label, Select } from "@/components/ui/field.tsx";
import { api } from "@/lib/api/client.ts";
import { errorMessage } from "@/lib/errors.ts";
import { formatDate } from "@/lib/time.ts";
import { ageDays, Chip, DataTable, ListState, useAdminList } from "./common.tsx";
import { ReasonDialog } from "./reason-dialog.tsx";

export function AdminUsers() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<UserStatus | "">("");
  const q = useDeferredValue(search.trim());
  const list = useAdminList("adminListUsers", {
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
  });
  const items = (list.data?.pages.flatMap((p) => p.items) ?? []) as AdminUser[];
  const queryClient = useQueryClient();
  const [suspending, setSuspending] = useState<AdminUser | null>(null);
  const [quotaFor, setQuotaFor] = useState<AdminUser | null>(null);
  const update = useMutation({
    mutationFn: ({ user, body }: { user: AdminUser; body: Parameters<typeof updateBody>[0] }) =>
      api("adminUpdateUser", { params: { userId: user.id }, body: updateBody(body) }),
    onSuccess: (u) => {
      toast.success(`已更新 @${u.githubLogin}`);
      setSuspending(null);
      setQuotaFor(null);
      queryClient.invalidateQueries({ queryKey: ["adminListUsers"] });
    },
    onError: (e) => toast.error("更新失敗", { description: errorMessage(e) }),
  });

  return (
    <div>
      <h1 className="text-step-3 font-semibold tracking-tight">使用者</h1>
      <div className="mt-5 flex flex-wrap gap-3">
        <label htmlFor="user-search" className="sr-only">
          搜尋 GitHub 帳號
        </label>
        <Input
          id="user-search"
          data-search
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜尋 GitHub 帳號"
          className="zone max-w-xs"
        />
        <label htmlFor="user-status" className="sr-only">
          狀態
        </label>
        <Select
          id="user-status"
          value={status}
          onChange={(e) => setStatus(e.target.value as UserStatus | "")}
          className="w-36"
        >
          <option value="">所有狀態</option>
          <option value="active">正常</option>
          <option value="suspended">已停權</option>
        </Select>
      </div>
      <div className="mt-5">
        <ListState query={list} empty={items.length === 0}>
          <DataTable
            label="使用者清單"
            head={["帳號", "角色", "GitHub 年齡", "子網域", "配額覆寫", "最後登入", ""]}
          >
            {items.map((u) => (
              <tr key={u.id} className="hover:bg-surface">
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-2">
                    <Avatar src={u.avatarUrl} login={u.githubLogin} size={22} />
                    <span className="zone">@{u.githubLogin}</span>
                    {u.status === "suspended" ? <Chip tone="danger">停權</Chip> : null}
                  </span>
                  {u.suspendedReason ? (
                    <span className="mt-1 block text-xs text-danger">{u.suspendedReason}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2.5">
                  {u.role === "admin" ? <Chip tone="magpie">admin</Chip> : <Chip>user</Chip>}
                </td>
                <td
                  className={`zone px-3 py-2.5 ${ageDays(u.githubCreatedAt) < 30 ? "text-amber" : ""}`}
                >
                  {ageDays(u.githubCreatedAt)} 天
                </td>
                <td className="zone px-3 py-2.5">{u.subdomainCount}</td>
                <td className="zone px-3 py-2.5 text-ink-muted">
                  {u.quotaOverride
                    ? `${u.quotaOverride.subdomains ?? "—"} 個 / ${u.quotaOverride.recordsPerSubdomain ?? "—"} 筆`
                    : "預設"}
                </td>
                <td className="zone px-3 py-2.5 text-ink-muted">{formatDate(u.lastLoginAt)}</td>
                <td className="space-x-1 px-3 py-2.5 text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => setQuotaFor(u)}>
                    配額
                  </Button>
                  {u.status === "active" ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setSuspending(u)}
                      disabled={u.role === "admin"}
                    >
                      停權
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        update.mutate({ user: u, body: { status: "active", reason: "" } })
                      }
                    >
                      解除
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        </ListState>
      </div>
      <ReasonDialog
        open={Boolean(suspending)}
        onOpenChange={(v) => !v && setSuspending(null)}
        title={`停權 @${suspending?.githubLogin ?? ""}`}
        description="對方所有 session 會立即失效。"
        confirmLabel="停權使用者"
        pending={update.isPending}
        onSubmit={(reason) =>
          suspending && update.mutate({ user: suspending, body: { status: "suspended", reason } })
        }
      />
      <QuotaDialog
        user={quotaFor}
        onClose={() => setQuotaFor(null)}
        pending={update.isPending}
        error={update.isError ? errorMessage(update.error) : null}
        onSave={(user, quota) => update.mutate({ user, body: { quota } })}
      />
    </div>
  );
}

function updateBody(body: {
  status?: UserStatus;
  reason?: string;
  quota?: { subdomains: number | null; recordsPerSubdomain: number | null } | null;
}) {
  const out: {
    status?: UserStatus;
    reason?: string;
    quotaOverride?: { subdomains: number | null; recordsPerSubdomain: number | null } | null;
  } = {};
  if (body.status) out.status = body.status;
  if (body.reason !== undefined && body.reason !== "") out.reason = body.reason;
  if (body.quota !== undefined) out.quotaOverride = body.quota;
  return out;
}

function QuotaDialog({
  user,
  onClose,
  onSave,
  pending,
  error,
}: {
  user: AdminUser | null;
  onClose: () => void;
  onSave: (
    user: AdminUser,
    quota: { subdomains: number | null; recordsPerSubdomain: number | null } | null,
  ) => void;
  pending: boolean;
  error: string | null;
}) {
  const id = useId();
  const [subs, setSubs] = useState("");
  const [recs, setRecs] = useState("");
  const parse = (v: string) => (v.trim() === "" ? null : Number(v));
  return (
    <Dialog
      open={Boolean(user)}
      onOpenChange={(v) => {
        if (v && user) {
          setSubs(String(user.quotaOverride?.subdomains ?? ""));
          setRecs(String(user.quotaOverride?.recordsPerSubdomain ?? ""));
        }
        if (!v) onClose();
      }}
    >
      <DialogContent
        title={`@${user?.githubLogin ?? ""} 的配額`}
        description="留空代表使用全域預設（每人 2 個子網域、每個 10 筆紀錄）。"
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!user) return;
            const s = parse(subs);
            const r = parse(recs);
            onSave(
              user,
              s === null && r === null ? null : { subdomains: s, recordsPerSubdomain: r },
            );
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-subs`}>子網域上限</Label>
              <Input
                id={`${id}-subs`}
                inputMode="numeric"
                value={subs}
                onChange={(e) => setSubs(e.target.value)}
                placeholder="2"
                className="zone"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-recs`}>每個子網域紀錄上限</Label>
              <Input
                id={`${id}-recs`}
                inputMode="numeric"
                value={recs}
                onChange={(e) => setRecs(e.target.value)}
                placeholder="10"
                className="zone"
              />
            </div>
          </div>
          <FieldError>{error}</FieldError>
          <Button type="submit" className="w-full" disabled={pending}>
            儲存配額
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
