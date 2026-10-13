"use client";

import { RotateCw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button.tsx";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 不送任何第三方追蹤；digest 對應 server log，方便回報
  }, []);
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-24 sm:px-6">
      <p className="zone text-sm text-ink-muted">;; status: SERVFAIL</p>
      <h1 className="mt-3 text-step-4 font-semibold tracking-tight">出了點狀況</h1>
      <p className="mt-3 text-ink-muted">
        伺服器沒有正常回應。通常重試一次就好；如果一直發生，請到服務狀態頁看看，或寫信給我們並附上下面的代碼。
      </p>
      {error.digest ? <p className="zone mt-4 text-sm">digest: {error.digest}</p> : null}
      <div className="mt-8 flex flex-wrap gap-3">
        <Button onClick={reset}>
          <RotateCw aria-hidden />
          再試一次
        </Button>
        <Link
          href="/status"
          className="inline-flex h-10 items-center px-2 underline underline-offset-4"
        >
          服務狀態
        </Link>
      </div>
    </main>
  );
}
