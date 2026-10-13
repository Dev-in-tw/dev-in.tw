import { Suspense } from "react";
import { RecordEditor } from "@/components/records/editor.tsx";
import { loadSubdomain } from "@/lib/api/load.ts";
import { getServerApi } from "@/lib/api/server.ts";

export default async function RecordsPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const api = getServerApi();
  const [sub, records, mine] = await Promise.all([
    loadSubdomain(name),
    api("listRecords", { params: { name } }),
    api("listSubdomains"),
  ]);
  return (
    <Suspense>
      <RecordEditor
        subdomain={sub}
        initial={records}
        ownedSubdomains={mine.items.map((s) => s.name)}
      />
    </Suspense>
  );
}
