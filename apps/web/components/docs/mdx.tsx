import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import type { ComponentProps } from "react";

function A({ href = "", ...props }: ComponentProps<"a">) {
  if (href.startsWith("/")) return <Link href={href} className="link" {...props} />;
  return <a href={href} className="link" rel="noreferrer" {...props} />;
}

export const mdxComponents: MDXComponents = {
  a: A,
};
