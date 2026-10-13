import { Suspense } from "react";
import { AdminUsers } from "@/components/admin/users.tsx";

export const metadata = { title: "使用者" };

export default function Page() {
  return (
    <Suspense>
      <AdminUsers />
    </Suspense>
  );
}
