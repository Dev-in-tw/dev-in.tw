import type { Metadata } from "next";
import { LegalHeader } from "@/components/legal/header.tsx";
import Content from "@/content/legal/privacy.mdx";
import { LEGAL_DOCS } from "@/lib/legal.ts";

const doc = LEGAL_DOCS.privacy;

export const metadata: Metadata = {
  title: doc.title,
  description: doc.description,
  alternates: { canonical: "/privacy" },
};

export default function Page() {
  return (
    <>
      <LegalHeader doc={doc} />
      <Content />
    </>
  );
}
