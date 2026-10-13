"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { PreferencesProvider } from "@/lib/preferences.tsx";
import { makeQueryClient } from "@/lib/query.ts";
import { ThemeProvider } from "@/lib/theme.tsx";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return (
    <ThemeProvider>
      <PreferencesProvider>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </PreferencesProvider>
    </ThemeProvider>
  );
}
