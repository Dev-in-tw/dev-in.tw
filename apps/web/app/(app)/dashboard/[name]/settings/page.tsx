import { SubdomainSettings } from "@/components/subdomain/settings.tsx";
import { loadSubdomain } from "@/lib/api/load.ts";

export default async function SubdomainSettingsPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const sub = await loadSubdomain(name);
  return <SubdomainSettings initial={sub} />;
}
