import Link from "next/link";
import { Hero } from "@/components/landing/hero.tsx";
import { HowItWorks } from "@/components/landing/how-it-works.tsx";
import { PresetShowcase } from "@/components/landing/preset-showcase.tsx";
import { Principles } from "@/components/landing/principles.tsx";
import { Stats } from "@/components/landing/stats.tsx";
import { Ticker } from "@/components/landing/ticker.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";

export default function HomePage() {
  return (
    <>
      <Hero />
      <Ticker />
      <HowItWorks />
      <PresetShowcase />
      <Stats />
      <Principles />
      <section className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="relative overflow-hidden rounded-[var(--radius-dialog)] bg-magpie px-6 py-12 text-primary-fg sm:px-12 dark:bg-magpie-soft dark:text-ink">
          <p className="zone text-sm opacity-80">; ready?</p>
          <h2 className="mt-2 max-w-2xl text-step-3 font-semibold tracking-tight">
            名字不會等人。趁 <span className="zone whitespace-nowrap">你的名字.dev-in.tw</span>{" "}
            還沒被拿走。
          </h2>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/#claim" className={buttonVariants({ variant: "secondary", size: "lg" })}>
              回到上面查名字
            </Link>
            <Link
              href="/docs"
              className="inline-flex h-12 items-center px-2 underline underline-offset-4"
            >
              先看看文件
            </Link>
          </div>
          <svg
            aria-hidden="true"
            viewBox="0 0 32 32"
            className="absolute -right-8 -bottom-10 size-56 opacity-15"
          >
            <path
              d="M4 4h11a12 12 0 0 1 0 24H4zM8 10v12h3V10z"
              fill="currentColor"
              fillRule="evenodd"
            />
            <circle cx="27.5" cy="25" r="3.5" fill="var(--beak)" />
          </svg>
        </div>
      </section>
    </>
  );
}
