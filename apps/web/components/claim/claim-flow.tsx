"use client";

import type { Availability, Me, Subdomain } from "@dit/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useId,
  useState,
  ViewTransition,
} from "react";
import { GithubMark } from "@/components/brand/github-mark.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Checkbox, FieldError, FieldHint, Label, Textarea } from "@/components/ui/field.tsx";
import { api, idempotencyKey, isApiError } from "@/lib/api/client.ts";
import { isClaimable, toneOf } from "@/lib/availability.ts";
import { cn } from "@/lib/cn.ts";
import { errorMessage } from "@/lib/errors.ts";
import { t } from "@/lib/i18n/zh-Hant.ts";
import { q } from "@/lib/queries.ts";
import { ClaimTerminal } from "./terminal.tsx";
import { TicketStage } from "./ticket.tsx";
import { Turnstile } from "./turnstile.tsx";

const DRAFT_KEY = (name: string) => `dit-claim-draft:${name}`;

/** 申請流程（§4.3 Claim）：單頁三段，不用 Dialog。成功後翻成開通票券。 */
export function ClaimFlow({ name, me }: { name: string; me: Me | null }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<Availability | null>(null);
  const [description, setDescription] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [resetTurnstile, setResetTurnstile] = useState(0);
  const [created, setCreated] = useState<Subdomain | null>(null);
  const [serial, setSerial] = useState<number | null>(null);
  const [key] = useState(idempotencyKey);
  const meta = useQuery(q.meta());
  const descId = useId();
  const agreeId = useId();

  // 未登入時先存草稿，登入回來後還原（PLAN：登入後回到原頁且狀態保留）
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY(name));
      if (raw) {
        const draft = JSON.parse(raw) as { description?: string; agreed?: boolean };
        setDescription(draft.description ?? "");
        setAgreed(Boolean(draft.agreed));
      }
    } catch {
      // 沒有草稿或無法讀取
    }
  }, [name]);

  const onResult = useCallback((r: Availability | null) => setResult(r), []);

  const create = useMutation({
    mutationFn: () =>
      api("createSubdomain", {
        body: { name, description, acceptTerms: true, turnstileToken: token ?? "" },
        idempotencyKey: key,
      }),
    onSuccess: async (sub) => {
      try {
        sessionStorage.removeItem(DRAFT_KEY(name));
      } catch {}
      queryClient.invalidateQueries({ queryKey: ["listSubdomains"] });
      const stats = await queryClient.fetchQuery(q.stats()).catch(() => null);
      setSerial(stats ? stats.subdomains : null);
      setCreated(sub);
    },
    onError: (error) => {
      if (isApiError(error, "TURNSTILE_FAILED")) setResetTurnstile((n) => n + 1);
    },
  });

  const claimable = result ? isClaimable(result.status) : false;
  const registrationClosed = meta.data && !meta.data.registrationOpen;
  const loginHref = `/login?redirect=${encodeURIComponent(`/claim/${name}`)}`;

  const saveDraftAndLogin = () => {
    try {
      sessionStorage.setItem(DRAFT_KEY(name), JSON.stringify({ description, agreed }));
    } catch {}
    window.location.href = loginHref;
  };

  const front = (
    <div className="space-y-8">
      <ClaimTerminal
        initialName={name}
        size="md"
        autoFocus={false}
        onResult={onResult}
        onSubmit={(next) => {
          if (next !== name)
            startTransition(() => router.replace(`/claim/${encodeURIComponent(next)}`));
        }}
      />

      {result && !claimable ? <NotClaimable result={result} /> : null}

      {result && claimable ? (
        <form
          className="space-y-0 overflow-hidden rounded-[var(--radius-dialog)] border border-rule bg-bg shadow-[4px_4px_0_var(--shadow)]"
          onSubmit={(e) => {
            e.preventDefault();
            if (!me) return saveDraftAndLogin();
            create.mutate();
          }}
          aria-labelledby="apply-title"
        >
          <h2 id="apply-title" className="sr-only">
            申請 {result.fqdn}
          </h2>
          <Step no={1} title="名稱確認">
            <p className="zone text-step-1">
              <ViewTransition name={`sub-${name}`} share="morph" default="none">
                <span className="font-semibold">{name}</span>
              </ViewTransition>
              <span className="text-ink-muted">.dev-in.tw</span>
            </p>
            {result.status === "review" ? (
              <div className="mt-3 rounded-md border border-amber bg-amber-soft p-3 text-sm">
                <p className="font-medium">送出後需要人工審核</p>
                <ul className="mt-1 list-inside list-disc text-ink-muted">
                  {(result.reviewReasons ?? []).map((r) => (
                    <li key={r}>{t.reviewReason(r)}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-1 text-sm text-ink-muted">可以直接開通，不需要審核。</p>
            )}
          </Step>

          <Step no={2} title="用途與規範">
            <div className="space-y-2">
              <Label htmlFor={descId}>用途描述（選填）</Label>
              <Textarea
                id={descId}
                value={description}
                maxLength={280}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="例如：我的個人網站與技術部落格"
                aria-describedby={`${descId}-hint`}
              />
              <FieldHint id={`${descId}-hint`}>
                {description.length}/280。若之後開啟公開展示，這段文字會出現在成員牆上。
              </FieldHint>
            </div>
            <div className="mt-5 rounded-md border border-rule bg-surface p-4 text-sm">
              <p className="font-medium">使用規範摘要</p>
              <ul className="mt-2 list-inside list-disc space-y-1 text-ink-muted">
                <li>不得用於釣魚、詐騙、散布惡意程式或違法內容</li>
                <li>不得冒用他人或品牌身分</li>
                <li>違規會被停權並撤下 DNS 紀錄；釋出後名稱冷卻 30 天</li>
              </ul>
            </div>
            <div className="mt-4 flex items-start gap-3">
              <Checkbox
                id={agreeId}
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                required
              />
              <label htmlFor={agreeId} className="text-sm">
                我已閱讀並同意
                <Link href="/terms" className="link" target="_blank">
                  服務條款
                </Link>
                、
                <Link href="/privacy" className="link" target="_blank">
                  隱私權政策
                </Link>
                與
                <Link href="/aup" className="link" target="_blank">
                  使用規範
                </Link>
              </label>
            </div>
          </Step>

          <Step no={3} title="驗證並送出" last>
            {registrationClosed ? (
              <p role="alert" className="text-sm text-danger">
                {t.errors.REGISTRATION_CLOSED}
              </p>
            ) : me ? (
              <div className="space-y-4">
                <Turnstile
                  siteKey={meta.data?.turnstileSiteKey}
                  onToken={setToken}
                  resetSignal={resetTurnstile}
                />
                <FieldError>{create.isError ? errorMessage(create.error) : null}</FieldError>
                <Button type="submit" size="lg" disabled={!agreed || !token || create.isPending}>
                  <Send aria-hidden />
                  {create.isPending ? "送出中…" : result.status === "review" ? "送出審核" : "開通"}
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-ink-muted">
                  申請前需要先用 GitHub 登入。你填的內容會先保留，登入後回到這裡繼續。
                </p>
                <Button type="submit" size="lg">
                  <GithubMark className="size-5" />
                  登入後申請
                </Button>
              </div>
            )}
          </Step>
        </form>
      ) : null}
    </div>
  );

  return (
    <TicketStage
      front={front}
      subdomain={created}
      serial={serial}
      githubLogin={me?.githubLogin ?? ""}
    />
  );
}

function Step({
  no,
  title,
  last,
  children,
}: {
  no: number;
  title: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset
      className={cn(
        "grid gap-4 p-5 sm:grid-cols-[2.5rem_1fr] sm:p-6",
        !last && "border-b border-rule",
      )}
    >
      <legend className="sr-only">
        步驟 {no}：{title}
      </legend>
      <span
        aria-hidden
        className="zone inline-flex size-8 items-center justify-center rounded-full border border-magpie text-sm font-semibold text-magpie"
      >
        {no}
      </span>
      <div>
        <p aria-hidden className="mb-3 font-semibold">
          {title}
        </p>
        {children}
      </div>
    </fieldset>
  );
}

function NotClaimable({ result }: { result: Availability }) {
  const tone = toneOf(result.status);
  const copy = t.availability[result.status];
  return (
    <div
      className={cn(
        "rounded-[var(--radius-dialog)] border p-5 sm:p-6",
        tone === "warn" ? "border-amber bg-amber-soft" : "border-danger bg-danger-soft",
      )}
    >
      <p className="zone text-sm font-semibold">
        ;; {copy.code} · {copy.text}
      </p>
      <p className="mt-2">{result.reason ?? "這個名稱目前不能申請。"}</p>
      {result.status === "taken" ? (
        <p className="mt-2 text-sm">
          覺得這個網站有問題？
          <Link href={`/report?name=${encodeURIComponent(result.name)}`} className="link">
            檢舉 {result.fqdn}
          </Link>
        </p>
      ) : null}
      {result.suggestions.length ? (
        <div className="mt-4">
          <p className="text-sm text-ink-muted">這些名稱可以申請：</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {result.suggestions.map((s) => (
              <li key={s}>
                <Link
                  href={`/claim/${s}`}
                  className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "zone")}
                >
                  {s}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.status === "capacity_full" ? (
        <p className="mt-3 text-sm text-ink-muted">
          我們正在擴充容量。可以先到
          <a className="link" href="https://github.com/Dev-in-tw/dev-in.tw/discussions">
            GitHub Discussions
          </a>
          登記候補。
        </p>
      ) : null}
    </div>
  );
}
