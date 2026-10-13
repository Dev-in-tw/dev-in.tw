import type { Metadata } from "next";
import { Suspense } from "react";
import { ReportForm } from "@/components/public/report-form.tsx";
import { Eyebrow } from "@/components/ui/card.tsx";
import { SITE } from "@/lib/site.ts";

export const metadata: Metadata = {
  title: "檢舉濫用",
  description: "發現 dev-in.tw 底下有釣魚、詐騙或惡意程式？告訴我們。",
  alternates: { canonical: "/report" },
};

export default function ReportPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-14 sm:px-6">
      <Eyebrow>report abuse</Eyebrow>
      <h1 className="mt-2 text-step-4 font-semibold tracking-tight">檢舉濫用</h1>
      <p className="mt-2 text-ink-muted">
        不需要登入。緊急的資安問題請直接寫信到{" "}
        <a className="link" href={`mailto:${SITE.emails.security}`}>
          {SITE.emails.security}
        </a>
        ，其他濫用也可以寄到{" "}
        <a className="link" href={`mailto:${SITE.emails.abuse}`}>
          {SITE.emails.abuse}
        </a>
        。
      </p>
      <div className="mt-8">
        <Suspense>
          <ReportForm />
        </Suspense>
      </div>
    </div>
  );
}
