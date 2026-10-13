"use client";

import type { ReportCategory, ReportReceipt } from "@dit/contract";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { Turnstile } from "@/components/claim/turnstile.tsx";
import { Button } from "@/components/ui/button.tsx";
import { FieldError, FieldHint, Input, Label, Select, Textarea } from "@/components/ui/field.tsx";
import { api, isApiError } from "@/lib/api/client.ts";
import { normalizeInput } from "@/lib/availability.ts";
import { errorMessage, fieldErrors } from "@/lib/errors.ts";
import { t } from "@/lib/i18n/zh-Hant.ts";
import { q } from "@/lib/queries.ts";
import { formatDateTime } from "@/lib/time.ts";

const CATEGORIES = Object.keys(t.reportCategory) as ReportCategory[];

export function ReportForm() {
  const params = useSearchParams();
  const meta = useQuery(q.meta());
  const [subdomain, setSubdomain] = useState(() => normalizeInput(params.get("name") ?? ""));
  const [category, setCategory] = useState<ReportCategory>("phishing");
  const [details, setDetails] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [receipt, setReceipt] = useState<ReportReceipt | null>(null);
  const id = useId();
  const submit = useMutation({
    mutationFn: () =>
      api("createReport", {
        body: {
          subdomain,
          category,
          details: details.trim(),
          turnstileToken: token ?? "",
          ...(email.trim() ? { contactEmail: email.trim() } : {}),
        },
      }),
    onSuccess: setReceipt,
    onError: (e) => {
      if (isApiError(e, "TURNSTILE_FAILED")) setReset((n) => n + 1);
    },
  });
  const errors = submit.isError ? fieldErrors(submit.error) : {};

  if (receipt) {
    return (
      <div
        role="status"
        className="rounded-[var(--radius-dialog)] border border-signal bg-signal-soft p-6"
      >
        <CheckCircle2 className="size-6 text-signal" aria-hidden />
        <h2 className="mt-3 text-step-2 font-semibold">收到了，謝謝你</h2>
        <p className="mt-2">
          我們會盡快處理 <span className="zone font-semibold">{subdomain}.dev-in.tw</span>
          。確認違規會停權並撤下 DNS 紀錄。
        </p>
        <p className="zone mt-4 text-sm text-ink-muted">
          受理編號 {receipt.id}
          <br />
          {formatDateTime(receipt.createdAt)}
        </p>
      </div>
    );
  }

  return (
    <form
      className="space-y-6 rounded-[var(--radius-dialog)] border border-rule bg-bg p-6 shadow-[4px_4px_0_var(--shadow)] sm:p-8"
      onSubmit={(e) => {
        e.preventDefault();
        submit.mutate();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-sub`}>被檢舉的子網域</Label>
        <div className="zone flex items-center gap-1">
          <Input
            id={`${id}-sub`}
            value={subdomain}
            onChange={(e) => setSubdomain(normalizeInput(e.target.value))}
            required
            className="zone max-w-xs"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={Boolean(errors.subdomain)}
          />
          <span className="text-ink-muted">.dev-in.tw</span>
        </div>
        <FieldError>{errors.subdomain}</FieldError>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-cat`}>類型</Label>
        <Select
          id={`${id}-cat`}
          value={category}
          onChange={(e) => setCategory(e.target.value as ReportCategory)}
          className="max-w-xs"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t.reportCategory[c]}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-details`}>說明</Label>
        <Textarea
          id={`${id}-details`}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          minLength={10}
          maxLength={2000}
          required
          rows={6}
          placeholder="發生了什麼事？請附上具體的網址或截圖描述，方便我們查證。"
          aria-describedby={`${id}-details-hint`}
          aria-invalid={Boolean(errors.details)}
        />
        <FieldHint id={`${id}-details-hint`}>{details.trim().length}/2000，至少 10 個字</FieldHint>
        <FieldError>{errors.details}</FieldError>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-email`}>聯絡 email（選填）</Label>
        <Input
          id={`${id}-email`}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="max-w-sm"
          autoComplete="email"
          aria-describedby={`${id}-email-hint`}
        />
        <FieldHint id={`${id}-email-hint`}>只用來回覆這次檢舉，不會公開。</FieldHint>
      </div>
      <Turnstile siteKey={meta.data?.turnstileSiteKey} onToken={setToken} resetSignal={reset} />
      <FieldError>{submit.isError ? errorMessage(submit.error) : null}</FieldError>
      <Button
        type="submit"
        size="lg"
        disabled={!token || submit.isPending || details.trim().length < 10 || !subdomain}
      >
        {submit.isPending ? "送出中…" : "送出檢舉"}
      </Button>
    </form>
  );
}
