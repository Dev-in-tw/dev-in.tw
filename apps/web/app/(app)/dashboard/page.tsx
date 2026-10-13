import type { Metadata } from "next";
import { DashboardOverview } from "@/components/dashboard/overview.tsx";
import { authed, getServerApi } from "@/lib/api/server.ts";

export const metadata: Metadata = { title: "控制台", robots: { index: false } };

export default async function DashboardPage() {
  const { items } = await authed(getServerApi()("listSubdomains"));
  return <DashboardOverview initial={items} />;
}
