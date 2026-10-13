import type { ReactNode } from "react";
import { SITE } from "@/lib/site.ts";

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <p
        role="note"
        className="zone mb-8 rounded-md border border-amber bg-amber-soft px-4 py-3 text-sm"
      >
        ;; DRAFT：這份文件是草稿，正式版本待擁有者（{SITE.operatorShort}）確認後公告。
      </p>
      <article>{children}</article>
      <p className="mt-16 border-t border-rule pt-6 text-sm text-ink-muted">
        營運者：{SITE.operator}
      </p>
    </div>
  );
}
