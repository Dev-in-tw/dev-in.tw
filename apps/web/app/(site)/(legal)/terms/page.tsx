import type { Metadata } from "next";
import Content from "@/content/legal/terms.mdx";

export const metadata: Metadata = {
  title: "服務條款",
  description: "Dev-in.tw 的服務條款：子網域使用權、帳號、停權與免責。",
  alternates: { canonical: "/terms" },
};

export default function Page() {
  return <Content />;
}
