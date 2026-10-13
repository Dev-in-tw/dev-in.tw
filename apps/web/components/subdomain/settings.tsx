"use client";

import type { Subdomain, Transfer } from "@dit/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Eye, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog.tsx";
import { Checkbox, FieldError, FieldHint, Input, Label, Textarea } from "@/components/ui/field.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { api, isNotImplemented } from "@/lib/api/client.ts";
import { errorMessage, fieldErrors } from "@/lib/errors.ts";
import { t } from "@/lib/i18n/zh-Hant.ts";
import { q } from "@/lib/queries.ts";
import { formatDateTime } from "@/lib/time.ts";

function Section({
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
      className={`rounded-md border p-5 sm:p-6 ${danger ? "border-danger" : "border-rule shadow-[4px_4px_0_var(--shadow)]"} bg-bg`}
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

export function SubdomainSettings({ initial }: { initial: Subdomain }) {
  const queryClient = useQueryClient();
  const { data: sub = initial } = useQuery({ ...q.subdomain(initial.name), initialData: initial });
  const [description, setDescription] = useState(sub.description);
  const descId = useId();

  const update = useMutation({
    mutationFn: (body: { description?: string; showInDirectory?: boolean }) =>
      api("updateSubdomain", { params: { name: sub.name }, body }),
    onSuccess: (next) => {
      queryClient.setQueryData(q.subdomain(sub.name).queryKey, next);
      queryClient.invalidateQueries({ queryKey: ["listSubdomains"] });
      toast.success("已儲存");
    },
    onError: (e) => toast.error("儲存失敗", { description: errorMessage(e) }),
  });

  return (
    <div className="grid max-w-3xl gap-6">
      <Section title="描述與公開展示" icon={<Eye className="size-5 text-magpie" aria-hidden />}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ description });
          }}
        >
          <Label htmlFor={descId}>描述</Label>
          <Textarea
            id={descId}
            value={description}
            maxLength={280}
            onChange={(e) => setDescription(e.target.value)}
            aria-describedby={`${descId}-hint`}
          />
          <FieldHint id={`${descId}-hint`}>{description.length}/280</FieldHint>
          <Button
            type="submit"
            size="sm"
            disabled={update.isPending || description === sub.description}
          >
            儲存描述
          </Button>
        </form>
        <div className="mt-6 flex items-start justify-between gap-6 border-t border-rule pt-5">
          <div>
            <p id="dir-label" className="font-medium">
              在成員牆公開展示
            </p>
            <p className="text-sm text-ink-muted">
              開啟後，名稱、描述與你的 GitHub 頭像會出現在 /explore 與首頁地圖上。預設不公開。
            </p>
          </div>
          <Switch
            aria-labelledby="dir-label"
            checked={sub.showInDirectory}
            disabled={update.isPending || sub.status !== "active"}
            onCheckedChange={(checked) => update.mutate({ showInDirectory: checked })}
          />
        </div>
      </Section>

      <TransferSection sub={sub} />
      <ReleaseSection sub={sub} />
    </div>
  );
}

function TransferSection({ sub }: { sub: Subdomain }) {
  const queryClient = useQueryClient();
  const transfers = useQuery(q.transfers());
  const [login, setLogin] = useState("");
  const [keepRecords, setKeepRecords] = useState(true);
  const id = useId();
  const pending = transfers.data?.outgoing.find(
    (tr) => tr.subdomain === sub.name && tr.status === "pending",
  );

  const create = useMutation({
    mutationFn: () =>
      api("createTransfer", {
        params: { name: sub.name },
        body: { toGithubLogin: login.trim(), keepRecords },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["listTransfers"] });
      queryClient.invalidateQueries({ queryKey: ["getSubdomain"] });
      setLogin("");
      toast.success("已送出轉移邀請", { description: "對方 7 天內接受就會完成。" });
    },
  });
  const cancel = useMutation({
    mutationFn: (tr: Transfer) => api("cancelTransfer", { params: { transferId: tr.id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["listTransfers"] });
      toast("已取消轉移");
    },
  });

  if (transfers.error && isNotImplemented(transfers.error)) {
    return (
      <Section
        title="轉移擁有權"
        icon={<ArrowLeftRight className="size-5 text-magpie" aria-hidden />}
      >
        <p className="text-sm text-ink-muted" data-testid="transfer-coming-soon">
          擁有權轉移即將推出。
        </p>
      </Section>
    );
  }

  return (
    <Section
      title="轉移擁有權"
      icon={<ArrowLeftRight className="size-5 text-magpie" aria-hidden />}
    >
      {pending ? (
        <div className="space-y-3 text-sm">
          <p>
            已邀請 <span className="zone font-semibold">@{pending.to.githubLogin}</span> 接收，
            {t.transferStatus.pending}（到 {formatDateTime(pending.expiresAt)} 為止）。
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => cancel.mutate(pending)}
            disabled={cancel.isPending}
          >
            取消轉移
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <p className="text-sm text-ink-muted">
            對方需要先登入過 Dev-in.tw，並在 7 天內接受；接受時會檢查對方的配額。
          </p>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-login`}>對方的 GitHub 帳號</Label>
            <Input
              id={`${id}-login`}
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="octocat"
              className="zone max-w-xs"
              autoCapitalize="none"
              spellCheck={false}
              required
              aria-invalid={Boolean(fieldErrors(create.error).toGithubLogin)}
            />
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Checkbox
              id={`${id}-keep`}
              checked={keepRecords}
              onChange={(e) => setKeepRecords(e.target.checked)}
            />
            <label htmlFor={`${id}-keep`}>保留現有的 DNS 紀錄（取消勾選則轉移時清空）</label>
          </div>
          <FieldError>{create.isError ? errorMessage(create.error) : null}</FieldError>
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={!login.trim() || create.isPending || sub.status !== "active"}
          >
            送出轉移邀請
          </Button>
        </form>
      )}
    </Section>
  );
}

function ReleaseSection({ sub }: { sub: Subdomain }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState("");
  const id = useId();
  const release = useMutation({
    mutationFn: () => api("releaseSubdomain", { params: { name: sub.name }, body: { confirm } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["listSubdomains"] });
      queryClient.invalidateQueries({ queryKey: ["getMe"] });
      toast(`${sub.fqdn} 已釋出`);
      router.push("/dashboard");
      router.refresh();
    },
  });

  return (
    <Section title="危險區" icon={<TriangleAlert className="size-5" aria-hidden />} danger>
      <p className="text-sm">
        釋出後所有 DNS 紀錄會立刻撤下，名稱進入 <strong>30 天冷卻期</strong>
        ，期間任何人（包含你）都不能申請。
      </p>
      <Dialog onOpenChange={() => setConfirm("")}>
        <DialogTrigger asChild>
          <Button variant="danger" className="mt-4" disabled={sub.status === "releasing"}>
            釋出 {sub.name}
          </Button>
        </DialogTrigger>
        <DialogContent title={`釋出 ${sub.fqdn}？`} description="這個動作無法復原。">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              release.mutate();
            }}
          >
            <Label htmlFor={`${id}-confirm`}>
              請輸入 <span className="zone font-semibold">{sub.name}</span> 確認
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
            <FieldError>{release.isError ? errorMessage(release.error) : null}</FieldError>
            <Button
              type="submit"
              variant="danger-solid"
              className="w-full"
              disabled={confirm !== sub.name || release.isPending}
            >
              我了解，釋出這個子網域
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
