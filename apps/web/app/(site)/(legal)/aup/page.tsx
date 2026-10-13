import type { Metadata } from "next";
import Content from "@/content/legal/aup.mdx";

export const metadata: Metadata = {
  title: "使用規範",
  description: "Dev-in.tw 的使用規範：禁止釣魚、惡意程式、冒用與垃圾訊息。",
  alternates: { canonical: "/aup" },
};

export default function Page() {
  return <Content />;
}
