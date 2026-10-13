import type { MetadataRoute } from "next";
import { DOCS } from "@/lib/docs.ts";
import { SITE } from "@/lib/site.ts";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = [
    "",
    "/explore",
    "/docs",
    "/status",
    "/report",
    "/login",
    "/terms",
    "/privacy",
    "/aup",
  ];
  return [
    ...pages.map((p) => ({
      url: `${SITE.origin}${p}`,
      changeFrequency: "weekly" as const,
      priority: p === "" ? 1 : 0.6,
    })),
    ...DOCS.map((d) => ({
      url: `${SITE.origin}/docs/${d.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.5,
    })),
  ];
}
