import type { ReactNode } from "react";
import { PageBody } from "@/components/app/page-header.tsx";
import { SubdomainHeader, TabPanel } from "@/components/subdomain/header.tsx";
import { loadSubdomain } from "@/lib/api/load.ts";

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return { title: `${name}.dev-in.tw`, robots: { index: false } };
}

export default async function SubdomainLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const sub = await loadSubdomain(name);
  return (
    <PageBody>
      <SubdomainHeader initial={sub} />
      <TabPanel>{children}</TabPanel>
    </PageBody>
  );
}
