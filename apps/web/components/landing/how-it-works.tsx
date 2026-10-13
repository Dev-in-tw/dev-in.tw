import { Eyebrow } from "@/components/ui/card.tsx";

const STEPS = [
  {
    no: "01",
    title: "登入",
    body: "用 GitHub 帳號登入。我們只讀公開資料與主要 email，不碰你的 repo。",
    line: ["@", "IN", "LOGIN", "github.com/you"],
  },
  {
    no: "02",
    title: "申請",
    body: "挑一個 3–32 字元的名字，勾選同意條款就開通。少數名稱會先經過人工審核。",
    line: ["you", "IN", "CLAIM", "you.dev-in.tw."],
  },
  {
    no: "03",
    title: "指向",
    body: "在網頁上新增 DNS 紀錄，或一鍵套用 GitHub Pages、Vercel 等設定，通常一秒內就同步。",
    line: ["you", "IN", "CNAME", "you.github.io."],
  },
];

/** 運作方式：三行 zone file，捲動時由左往右展開，連接線跟著畫出（§4.4 #3，純 CSS） */
export function HowItWorks() {
  return (
    <section aria-labelledby="how-title" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <Eyebrow>how it works</Eyebrow>
      <h2 id="how-title" className="mt-2 text-step-4 font-semibold tracking-tight">
        三行 zone file，就是你的名字
      </h2>
      <ol className="relative mt-12 space-y-10">
        <svg
          aria-hidden="true"
          className="absolute top-3 bottom-3 left-[1.15rem] hidden h-[calc(100%-1.5rem)] w-px overflow-visible sm:block"
          preserveAspectRatio="none"
          viewBox="0 0 1 100"
        >
          <line
            x1="0.5"
            y1="0"
            x2="0.5"
            y2="100"
            stroke="var(--magpie)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            pathLength={1}
            strokeDasharray="1"
            className="scroll-draw"
          />
        </svg>
        {STEPS.map((step) => (
          <li key={step.no} className="relative grid gap-4 sm:grid-cols-[2.5rem_1fr] sm:gap-8">
            <span className="zone relative z-10 inline-flex size-9 items-center justify-center rounded-full border border-magpie bg-bg text-sm font-semibold text-magpie">
              {step.no}
            </span>
            <div className="grid gap-5 md:grid-cols-[1fr_1.3fr] md:items-center">
              <div>
                <h3 className="text-step-2 font-semibold">{step.title}</h3>
                <p className="mt-1 text-ink-muted">{step.body}</p>
              </div>
              <div className="scroll-reveal zone overflow-x-auto rounded-md border border-rule bg-surface px-4 py-3 text-[0.95rem] shadow-[4px_4px_0_var(--shadow)]">
                <span className="grid grid-cols-[6ch_4ch_7ch_1fr] gap-x-3 whitespace-nowrap">
                  <span className="text-ink">{step.line[0]}</span>
                  <span className="text-ink-muted">{step.line[1]}</span>
                  <span className="font-semibold text-beak">{step.line[2]}</span>
                  <span className="text-magpie">{step.line[3]}</span>
                </span>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
