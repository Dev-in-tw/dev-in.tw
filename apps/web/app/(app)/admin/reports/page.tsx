import { Suspense } from "react";
import { ReportsQueue } from "@/components/admin/reports.tsx";

export const metadata = { title: "檢舉佇列" };

export default function Page() {
  return (
    <Suspense>
      <ReportsQueue />
    </Suspense>
  );
}
