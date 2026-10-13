import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dev-in.tw",
    short_name: "Dev-in.tw",
    description: "給臺灣開發者的一個名字",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#faf9f5",
    theme_color: "#1e40af",
    lang: "zh-Hant",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
