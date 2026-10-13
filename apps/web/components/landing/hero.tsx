import localFont from "next/font/local";
import { HeroClaim } from "./hero-claim.tsx";
import { HeroMap } from "./hero-map.tsx";

// jf open 粉圓（OFL）：只用在 Hero 這一句，預先子集化到 5 KB 以內
const huninn = localFont({
  src: "../../app/fonts/huninn-hero.woff2",
  variable: "--font-huninn",
  display: "swap",
});

export function Hero() {
  return (
    <section className={`${huninn.variable} relative isolate overflow-hidden border-b border-rule`}>
      <div className="bg-dots absolute inset-0 -z-10" aria-hidden />
      <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-14 pb-16 sm:px-6 lg:grid-cols-[1.25fr_1fr] lg:pt-20 lg:pb-24">
        <div className="relative z-10 min-w-0">
          <p className="zone text-sm text-ink-muted">
            <span className="text-beak">;</span> $ORIGIN dev-in.tw.
          </p>
          <h1 className="mt-4">
            <span className="zone block text-step-6 leading-[0.9] font-bold tracking-[-0.04em]">
              DEV-IN<span className="text-beak">.</span>TW
            </span>
            <span className="mt-4 block font-[family-name:var(--font-hero)] text-step-3 text-magpie">
              給臺灣開發者的一個名字
            </span>
          </h1>
          <p className="mt-5 max-w-xl text-ink-muted">
            用 GitHub 登入，免費申請 <code className="zone text-ink">你的名字.dev-in.tw</code>
            ，指向 GitHub Pages、Vercel、Netlify
            或你自己的主機。每人兩個名字、每個十筆紀錄，不收個資。
          </p>
          <div id="claim" className="mt-8 max-w-2xl scroll-mt-24">
            <HeroClaim />
          </div>
        </div>
        <div className="relative hidden min-h-[440px] lg:block">
          <HeroMap />
          <p className="zone absolute right-0 bottom-0 text-right text-xs text-ink-muted">
            每一個亮點，都是一位公開展示的成員
            <br />
            <span className="text-beak">●</span> 剛加入的人會泛起漣漪
          </p>
        </div>
      </div>
    </section>
  );
}
