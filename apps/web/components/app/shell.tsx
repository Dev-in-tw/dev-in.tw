import type { Me } from "@dit/contract";
import type { ReactNode } from "react";
import { CommandPaletteHost } from "@/components/command/host.tsx";
import { MeProvider } from "@/lib/me.tsx";
import { AppClientProviders } from "./client-providers.tsx";
import { ConsentGate } from "./consent-gate.tsx";
import { AppNav, MobileTabs } from "./nav.tsx";

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  return (
    <MeProvider me={me}>
      <AppClientProviders>
        <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr] lg:bg-[linear-gradient(to_right,var(--surface)_calc(15rem-1px),var(--rule)_calc(15rem-1px),var(--rule)_15rem,transparent_15rem)]">
          <AppNav />
          <main id="main" tabIndex={-1} className="min-w-0 pb-24 outline-none lg:pb-0">
            {children}
          </main>
        </div>
        <MobileTabs />
        <CommandPaletteHost />
        <ConsentGate />
      </AppClientProviders>
    </MeProvider>
  );
}
