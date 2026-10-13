import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DOCS, findDoc } from "@/lib/docs.ts";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = findDoc((await params).slug);
  if (!doc) return {};
  return {
    title: doc.title,
    description: doc.description,
    alternates: { canonical: `/docs/${doc.slug}` },
  };
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  const doc = findDoc(slug);
  if (!doc) notFound();
  const { default: Content } = await import(`@/content/docs/${doc.slug}.mdx`);
  const index = DOCS.findIndex((d) => d.slug === doc.slug);
  const prev = DOCS[index - 1];
  const next = DOCS[index + 1];
  return (
    <article>
      <p className="zone text-sm text-ink-muted">docs / {doc.slug}</p>
      <Content />
      <nav
        aria-label="上一篇與下一篇"
        className="mt-16 flex justify-between gap-4 border-t border-rule pt-6 text-sm"
      >
        {prev ? (
          <Link href={`/docs/${prev.slug}`} className="link">
            ← {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={`/docs/${next.slug}`} className="link">
            {next.title} →
          </Link>
        ) : null}
      </nav>
    </article>
  );
}
