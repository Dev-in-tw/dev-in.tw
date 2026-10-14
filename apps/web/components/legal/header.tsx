import type { LegalDoc } from "@/lib/legal.ts";

/** 法務文件的標題區：標題、版本與生效日期（排版沿用 docs 的 h1） */
export function LegalHeader({ doc }: { doc: LegalDoc }) {
  return (
    <header>
      <p className="zone text-sm text-ink-muted">legal / {doc.slug}</p>
      <h1 className="mt-2 text-step-4 font-semibold tracking-tight">{doc.title}</h1>
      <dl className="zone mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-muted">
        <div className="flex gap-2">
          <dt>版本</dt>
          <dd className="text-ink">v{doc.version}</dd>
        </div>
        <div className="flex gap-2">
          <dt>生效日期</dt>
          <dd className="text-ink">
            <time dateTime={doc.effective}>{doc.effective}</time>
          </dd>
        </div>
      </dl>
    </header>
  );
}
