import type { Metadata } from "next";
import { connection } from "next/server";
import { ClaimFlow } from "@/components/claim/claim-flow.tsx";
import { Eyebrow } from "@/components/ui/card.tsx";
import { getMeSafe } from "@/lib/api/server.ts";
import { normalizeInput } from "@/lib/availability.ts";

type Props = { params: Promise<{ name: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name } = await params;
  const label = normalizeInput(decodeURIComponent(name));
  return {
    title: `申請 ${label}.dev-in.tw`,
    robots: { index: false },
  };
}

export default async function ClaimPage({ params }: Props) {
  await connection();
  const { name } = await params;
  const label = normalizeInput(decodeURIComponent(name));
  const me = await getMeSafe();

  return (
    <div className="relative">
      <div
        className="bg-dots pointer-events-none absolute inset-x-0 top-0 -z-10 h-80"
        aria-hidden
      />
      <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
        <Eyebrow>claim</Eyebrow>
        <h1 className="mt-2 text-step-4 font-semibold tracking-tight">
          申請 <span className="zone break-all">{label}.dev-in.tw</span>
        </h1>
        <p className="mt-2 text-ink-muted">
          {me
            ? `以 ${me.githubLogin} 的身分申請。你目前有 ${me.quota.subdomains.used}/${me.quota.subdomains.limit} 個子網域。`
            : "可以先查名字；按下申請時會請你用 GitHub 登入。"}
        </p>
        <div className="mt-8">
          <ClaimFlow key={label} name={label} me={me} />
        </div>
      </div>
    </div>
  );
}
