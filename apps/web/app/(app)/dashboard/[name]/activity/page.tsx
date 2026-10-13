import { SubdomainActivity } from "@/components/subdomain/activity.tsx";

export default async function SubdomainActivityPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  return <SubdomainActivity name={name} />;
}
