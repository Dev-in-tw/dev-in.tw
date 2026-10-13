import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AdminNav } from "@/components/admin/nav.tsx";
import { PageBody } from "@/components/app/page-header.tsx";
import { getMe } from "@/lib/api/server.ts";

export const metadata: Metadata = {
  title: { default: "管理", template: "%s · 管理 · Dev-in.tw" },
  robots: { index: false },
};

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  // 非 admin 一律 404，不透露後台存在（與 API 行為一致）
  if (me?.role !== "admin") notFound();
  return (
    <PageBody className="max-w-7xl">
      <p className="zone text-sm text-ink-muted">
        <span className="text-beak">;</span> admin
      </p>
      <AdminNav />
      <div className="mt-8">{children}</div>
    </PageBody>
  );
}
