import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site.ts";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/dashboard", "/admin", "/settings", "/claim/", "/api/"],
      },
    ],
    sitemap: `${SITE.origin}/sitemap.xml`,
  };
}
