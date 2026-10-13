import type { Metadata } from "next";
import Content from "@/content/legal/privacy.mdx";

export const metadata: Metadata = {
  title: "隱私權政策",
  description: "Dev-in.tw 只收服務運作需要的資料：我們蒐集什麼、怎麼用、保存多久。",
  alternates: { canonical: "/privacy" },
};

export default function Page() {
  return <Content />;
}
