import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app/shell.tsx";
import { getMe } from "@/lib/api/server.ts";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  if (!me) redirect("/login");
  return <AppShell me={me}>{children}</AppShell>;
}
