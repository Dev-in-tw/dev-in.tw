"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { SyncProvider } from "@/lib/sse.tsx";
import { useTheme } from "@/lib/theme.tsx";

export function AppClientProviders({ children }: { children: ReactNode }) {
  const { resolved } = useTheme();
  return (
    <MotionConfig reducedMotion="user" transition={{ type: "spring", stiffness: 420, damping: 32 }}>
      <SyncProvider>{children}</SyncProvider>
      <Toaster
        theme={resolved}
        position="bottom-center"
        offset={88}
        toastOptions={{
          className:
            "!rounded-md !border !border-rule !bg-bg !text-ink !shadow-[4px_4px_0_var(--shadow)] !font-sans",
        }}
      />
    </MotionConfig>
  );
}
