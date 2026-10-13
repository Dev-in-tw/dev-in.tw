import type { Metadata } from "next";
import { StatusBoard } from "@/components/public/status.tsx";
import { Eyebrow } from "@/components/ui/card.tsx";

export const metadata: Metadata = {
  title: "服務狀態",
  description: "Dev-in.tw 的 API、資料庫、DNS 供應商與同步佇列的即時狀態。",
  alternates: { canonical: "/status" },
};

export default function StatusPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
      <Eyebrow>status</Eyebrow>
      <h1 className="mt-2 text-step-4 font-semibold tracking-tight">服務狀態</h1>
      <p className="mt-2 text-ink-muted">每 30 秒自動更新。遇到問題可以寫信到 hello@dev-in.tw。</p>
      <StatusBoard />
    </div>
  );
}
