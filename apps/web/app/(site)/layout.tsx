import type { ReactNode } from "react";
import { CommandPaletteHost } from "@/components/command/host.tsx";
import { SiteFooter } from "@/components/site/footer.tsx";
import { SiteHeader } from "@/components/site/header.tsx";

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="outline-none">
        {children}
      </main>
      <SiteFooter />
      <CommandPaletteHost />
    </>
  );
}
