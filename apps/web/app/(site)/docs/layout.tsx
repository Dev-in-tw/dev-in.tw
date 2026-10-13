import type { ReactNode } from "react";
import { DocsNav } from "@/components/docs/nav.tsx";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[13rem_1fr]">
      <DocsNav />
      <div className="min-w-0 max-w-3xl">{children}</div>
    </div>
  );
}
