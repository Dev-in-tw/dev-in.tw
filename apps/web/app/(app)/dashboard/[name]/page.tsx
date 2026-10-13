import { PresetPanel } from "@/components/subdomain/presets.tsx";
import { PropagationPanel } from "@/components/subdomain/propagation.tsx";
import { loadSubdomain } from "@/lib/api/load.ts";
import { getServerApi } from "@/lib/api/server.ts";

export default async function SubdomainOverviewPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const [sub, records] = await Promise.all([
    loadSubdomain(name),
    getServerApi()("listRecords", { params: { name } }),
  ]);
  return (
    <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
      <div className="min-w-0">
        <PresetPanel subdomain={sub} initialRecords={records} />
      </div>
      <div className="min-w-0">
        <PropagationPanel subdomain={sub} initialRecords={records} />
      </div>
    </div>
  );
}
