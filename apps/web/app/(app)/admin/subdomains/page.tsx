import { Suspense } from "react";
import { AdminSubdomains } from "@/components/admin/subdomains.tsx";

export const metadata = { title: "子網域" };

export default function Page() {
  return (
    <Suspense>
      <AdminSubdomains />
    </Suspense>
  );
}
