"use client";

import { useRouter } from "next/navigation";
import { startTransition } from "react";
import { ClaimTerminal } from "@/components/claim/terminal.tsx";

export function HeroClaim() {
  const router = useRouter();
  return (
    <ClaimTerminal
      onSubmit={(name) => startTransition(() => router.push(`/claim/${encodeURIComponent(name)}`))}
    />
  );
}
