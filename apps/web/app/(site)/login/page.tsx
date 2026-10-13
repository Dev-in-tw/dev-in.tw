import { Eye, EyeOff, KeyRound, Mail, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { GithubMark } from "@/components/brand/github-mark.tsx";
import { LogoMark } from "@/components/brand/logo.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { getMeSafe } from "@/lib/api/server.ts";
import { cn } from "@/lib/cn.ts";
import { safeRedirect } from "@/lib/redirect.ts";

export const metadata: Metadata = {
  title: "登入",
  description: "用 GitHub 登入 Dev-in.tw，申請與管理你的子網域。",
  alternates: { canonical: "/login" },
};

const ERRORS: Record<string, string> = {
  suspended: "這個帳號已被停權。如果你認為這是誤判，請寫信到 abuse@dev-in.tw。",
  oauth_failed: "GitHub 登入沒有完成，可能是你取消了授權，或 GitHub 暫時無法回應。再試一次吧。",
  state_mismatch: "登入連結已過期或被竄改（state 不符）。請重新按一次登入。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const params = await searchParams;
  const target = safeRedirect(params.redirect);
  const me = await getMeSafe();
  if (me) redirect(target);

  const errorKey = typeof params.error === "string" ? params.error : undefined;
  const error = errorKey ? (ERRORS[errorKey] ?? ERRORS.oauth_failed) : undefined;
  const start = `/api/v1/auth/github/start?redirect=${encodeURIComponent(target)}`;

  return (
    <div className="relative px-4 py-16 sm:py-24">
      <div className="bg-dots pointer-events-none absolute inset-0 -z-10" aria-hidden />
      <div className="mx-auto max-w-md">
        <div className="rounded-[var(--radius-dialog)] border border-rule bg-bg p-7 shadow-[6px_6px_0_var(--shadow)] sm:p-9">
          <LogoMark className="size-10" />
          <h1 className="mt-5 text-step-3 font-semibold tracking-tight">登入 Dev-in.tw</h1>
          <p className="mt-2 text-ink-muted">
            我們只用 GitHub 確認你是誰。按下按鈕後會先到 GitHub 授權，再回到這裡。
          </p>

          {error ? (
            <div
              role="alert"
              className="mt-6 rounded-md border border-danger bg-danger-soft p-3 text-sm text-ink"
            >
              <p className="zone font-semibold text-danger">;; ERROR: {errorKey}</p>
              <p className="mt-1">{error}</p>
            </div>
          ) : null}

          <a href={start} className={cn(buttonVariants({ size: "lg" }), "mt-7 w-full")}>
            <GithubMark className="size-5" />
            使用 GitHub 登入
          </a>

          <div className="mt-8 border-t border-rule pt-6">
            <h2 className="zone text-sm font-semibold">
              <span className="text-beak" aria-hidden>
                ;{" "}
              </span>
              會讀取的資料
            </h2>
            <ul className="mt-3 space-y-2.5 text-sm">
              <li className="flex gap-3">
                <Eye className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
                <span>GitHub 的公開資料：帳號、顯示名稱、頭像、帳號建立日期</span>
              </li>
              <li className="flex gap-3">
                <Mail className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
                <span>主要且已驗證的 email，只用來聯絡濫用與重要通知，不寄行銷信</span>
              </li>
              <li className="flex gap-3">
                <EyeOff className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
                <span>
                  <strong>不會</strong>存取你的 repo，也<strong>不會</strong>保存 GitHub token
                </span>
              </li>
              <li className="flex gap-3">
                <KeyRound className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
                <span>不收身分證字號、地址、電話或生日</span>
              </li>
              <li className="flex gap-3">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
                <span>
                  登入狀態存在 HttpOnly cookie，網頁上的 JavaScript 讀不到。詳見
                  <a href="/privacy" className="link">
                    隱私權政策
                  </a>
                  。
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
