import type { Metadata } from "next";
import { ExploreWall } from "@/components/public/explore.tsx";
import { Eyebrow } from "@/components/ui/card.tsx";

export const metadata: Metadata = {
  title: "成員展示",
  description: "在 Dev-in.tw 公開展示的開發者們。每個人都自己決定要不要出現在這裡。",
  alternates: { canonical: "/explore" },
};

export default function ExplorePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <Eyebrow>explore</Eyebrow>
      <h1 className="mt-2 text-step-4 font-semibold tracking-tight">住在 dev-in.tw 的人們</h1>
      <p className="mt-2 max-w-2xl text-ink-muted">
        只有主動開啟「公開展示」的成員會出現在這裡。想加入？在子網域設定裡打開就好。
      </p>
      <ExploreWall />
    </div>
  );
}
