"use client";

import type { Session } from "@dit/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Keyboard, Laptop, LogOut, Monitor, Smartphone, TriangleAlert, User } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/app/avatar.tsx";
import { PageBody, PageHeader } from "@/components/app/page-header.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog.tsx";
import { FieldError, Input, Label } from "@/components/ui/field.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { api, isNotImplemented } from "@/lib/api/client.ts";
import { errorMessage } from "@/lib/errors.ts";
import { useMe } from "@/lib/me.tsx";
import { usePreferences } from "@/lib/preferences.tsx";
import { q } from "@/lib/queries.ts";
import { formatDate, formatDateTime } from "@/lib/time.ts";

function Card({
  title,
  icon,
  children,
  danger,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <section
      className={`rounded-md border bg-bg p-5 sm:p-6 ${danger ? "border-danger" : "border-rule shadow-[4px_4px_0_var(--shadow)]"}`}
    >
      <h2
        className={`flex items-center gap-2 text-step-1 font-semibold ${danger ? "text-danger" : ""}`}
      >
        {icon}
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function UserSettings() {
  const me = useMe();
  return (
    <PageBody>
      <PageHeader
        eyebrow="settings"
        title="設定"
        description="個人資料來自 GitHub，在這裡只能檢視。"
      />
      <div className="mt-8 grid max-w-3xl gap-6">
        <Card title="個人資料" icon={<User className="size-5 text-magpie" aria-hidden />}>
          <div className="flex items-center gap-4">
            <Avatar src={me.avatarUrl} login={me.githubLogin} size={56} />
            <dl className="zone grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
              <dt className="text-ink-muted">GitHub</dt>
              <dd>@{me.githubLogin}</dd>
              <dt className="text-ink-muted">名稱</dt>
              <dd>{me.displayName ?? "（未設定）"}</dd>
              <dt className="text-ink-muted">email</dt>
              <dd>{me.email ?? "（沒有已驗證的主要 email）"}</dd>
              <dt className="text-ink-muted">加入</dt>
              <dd>{formatDate(me.createdAt)}</dd>
            </dl>
          </div>
          <p className="mt-4 text-sm text-ink-muted">
            要改名稱或頭像，請到 GitHub 修改，下次登入時會同步。
          </p>
        </Card>
        <Preferences />
        <Sessions />
        <DeleteAccount />
      </div>
    </PageBody>
  );
}

function Preferences() {
  const { prefs, setPref } = usePreferences();
  return (
    <Card title="操作偏好" icon={<Keyboard className="size-5 text-magpie" aria-hidden />}>
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p id="pref-shortcuts" className="font-medium">
              全域快捷鍵
            </p>
            <p className="text-sm text-ink-muted">
              ⌘K／Ctrl+K 指令面板、/ 聚焦搜尋、? 顯示快捷鍵。使用螢幕閱讀器時可以關閉。
            </p>
          </div>
          <Switch
            aria-labelledby="pref-shortcuts"
            checked={prefs.shortcuts}
            onCheckedChange={(v) => setPref("shortcuts", v)}
          />
        </div>
        <div className="flex items-start justify-between gap-6 border-t border-rule pt-5">
          <div>
            <p id="pref-motion" className="font-medium">
              暫停循環動畫
            </p>
            <p className="text-sm text-ink-muted">
              停止跑馬燈與同步掃描線。系統設定「減少動態效果」時會自動套用。
            </p>
          </div>
          <Switch
            aria-labelledby="pref-motion"
            checked={prefs.motionPaused}
            onCheckedChange={(v) => setPref("motionPaused", v)}
          />
        </div>
      </div>
    </Card>
  );
}

function deviceIcon(ua: string | null) {
  if (!ua) return Monitor;
  return /iPhone|Android|Mobile/i.test(ua) ? Smartphone : Laptop;
}

function deviceName(ua: string | null): string {
  if (!ua) return "未知裝置";
  const os = /Mac OS X/.test(ua)
    ? "macOS"
    : /Windows/.test(ua)
      ? "Windows"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Android/.test(ua)
          ? "Android"
          : /Linux/.test(ua)
            ? "Linux"
            : "其他系統";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "瀏覽器";
  return `${browser} · ${os}`;
}

function Sessions() {
  const queryClient = useQueryClient();
  const { data, error, isPending } = useQuery(q.sessions());
  const revoke = useMutation({
    mutationFn: (s: Session) => api("revokeSession", { params: { sessionId: s.id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["listSessions"] }),
    onError: (e) => toast.error("登出失敗", { description: errorMessage(e) }),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api("revokeOtherSessions"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["listSessions"] });
      toast.success("已登出其他所有裝置");
    },
  });

  return (
    <Card title="裝置與登入狀態" icon={<Laptop className="size-5 text-magpie" aria-hidden />}>
      {error && isNotImplemented(error) ? (
        <p className="text-sm text-ink-muted" data-testid="sessions-coming-soon">
          裝置管理即將推出。
        </p>
      ) : isPending ? (
        <p className="text-sm text-ink-muted">載入中…</p>
      ) : error ? (
        <p className="text-sm text-danger">{errorMessage(error)}</p>
      ) : (
        <>
          <ul className="divide-y divide-rule" data-testid="sessions">
            {data.items.map((s) => {
              const Icon = deviceIcon(s.userAgent);
              return (
                <li key={s.id} className="flex items-center gap-4 py-3">
                  <Icon className="size-5 text-ink-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {deviceName(s.userAgent)}
                      {s.current ? (
                        <span className="zone ml-2 text-xs text-signal">[ 目前這台 ]</span>
                      ) : null}
                    </p>
                    <p className="zone text-xs text-ink-muted">
                      {s.ipApprox ?? "IP 不明"} · 最後使用 {formatDateTime(s.lastSeenAt)}
                    </p>
                  </div>
                  {s.current ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => revoke.mutate(s)}
                      disabled={revoke.isPending}
                    >
                      登出
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {data.items.length > 1 ? (
            <Button
              size="sm"
              variant="secondary"
              className="mt-3"
              onClick={() => revokeOthers.mutate()}
              disabled={revokeOthers.isPending}
            >
              <LogOut aria-hidden />
              登出其他所有裝置
            </Button>
          ) : null}
        </>
      )}
    </Card>
  );
}

function DeleteAccount() {
  const me = useMe();
  const router = useRouter();
  const [confirm, setConfirm] = useState("");
  const id = useId();
  const del = useMutation({
    mutationFn: () => api("deleteMe", { body: { confirm } }),
    onSuccess: () => {
      router.push("/?deleted=1");
      router.refresh();
    },
  });
  return (
    <Card title="刪除帳號" icon={<TriangleAlert className="size-5" aria-hidden />} danger>
      <p className="text-sm">
        刪除後，你的所有子網域會被釋出並撤下 DNS 紀錄（名稱進入 30
        天冷卻期），帳號資料會被刪除，只保留法律要求的稽核紀錄。
      </p>
      <Dialog onOpenChange={() => setConfirm("")}>
        <DialogTrigger asChild>
          <Button variant="danger" className="mt-4">
            刪除我的帳號
          </Button>
        </DialogTrigger>
        <DialogContent title="確定要刪除帳號？" description="這個動作無法復原。">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              del.mutate();
            }}
          >
            <Label htmlFor={`${id}-confirm`}>
              請輸入你的 GitHub 帳號 <span className="zone font-semibold">{me.githubLogin}</span>{" "}
              確認
            </Label>
            <Input
              id={`${id}-confirm`}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="zone"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            <FieldError>{del.isError ? errorMessage(del.error) : null}</FieldError>
            <Button
              type="submit"
              variant="danger-solid"
              className="w-full"
              disabled={confirm !== me.githubLogin || del.isPending}
            >
              永久刪除帳號
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
