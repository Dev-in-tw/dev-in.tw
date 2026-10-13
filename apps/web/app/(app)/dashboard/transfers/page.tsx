import type { Metadata } from "next";
import { TransfersPage } from "@/components/dashboard/transfers.tsx";

export const metadata: Metadata = { title: "擁有權轉移", robots: { index: false } };

export default function Page() {
  return <TransfersPage />;
}
