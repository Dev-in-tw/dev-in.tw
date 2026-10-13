import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

function slug(children: ReactNode): string | undefined {
  return typeof children === "string"
    ? children
        .toLowerCase()
        .replace(/[^\w一-鿿-]+/g, "-")
        .replace(/^-|-$/g, "")
    : undefined;
}

function A({ href = "", className, ...props }: ComponentProps<"a">) {
  if (href.startsWith("/") && !href.startsWith("/api/"))
    return <Link href={href} className={cn("link", className)} {...props} />;
  return <a href={href} className={cn("link", className)} rel="noreferrer" {...props} />;
}

export const mdxComponents: MDXComponents = {
  a: A,
  h1: ({ children }) => <h1 className="text-step-4 font-semibold tracking-tight">{children}</h1>,
  h2: ({ children }) => (
    <h2
      id={slug(children)}
      className="mt-12 scroll-mt-24 border-t border-rule pt-8 text-step-2 font-semibold tracking-tight"
    >
      <span className="zone mr-2 text-beak" aria-hidden>
        ;
      </span>
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 id={slug(children)} className="mt-8 scroll-mt-24 text-step-1 font-semibold">
      {children}
    </h3>
  ),
  p: (props) => <p className="mt-4 leading-[1.85]" {...props} />,
  ul: (props) => <ul className="mt-4 list-disc space-y-2 pl-6 marker:text-ink-muted" {...props} />,
  ol: (props) => (
    <ol className="mt-4 list-decimal space-y-2 pl-6 marker:text-ink-muted" {...props} />
  ),
  li: (props) => <li className="leading-[1.8]" {...props} />,
  strong: (props) => <strong className="font-semibold text-ink" {...props} />,
  blockquote: (props) => (
    <blockquote
      className="mt-6 border-l-4 border-magpie bg-magpie-soft/60 px-4 py-3 [&>p]:mt-0"
      {...props}
    />
  ),
  hr: () => <hr className="my-10 border-rule" />,
  code: (props) => (
    <code className="zone rounded bg-surface-2 px-1.5 py-0.5 text-[0.88em]" {...props} />
  ),
  pre: ({ children, ...props }) => (
    <pre
      className="zone mt-5 overflow-x-auto rounded-md border border-rule bg-surface p-4 text-[0.88rem] leading-relaxed [&>code]:bg-transparent [&>code]:p-0"
      {...props}
    >
      {children}
    </pre>
  ),
  table: (props) => (
    <div className="mt-6 overflow-x-auto rounded-md border border-rule">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: (props) => (
    <th
      className="zone border-b border-rule bg-surface px-3 py-2 text-left font-semibold"
      {...props}
    />
  ),
  td: (props) => <td className="border-b border-rule px-3 py-2 align-top" {...props} />,
};
