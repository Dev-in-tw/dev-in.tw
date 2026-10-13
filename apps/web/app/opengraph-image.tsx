import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Dev-in.tw — 給臺灣開發者的一個名字";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// build 時產生的靜態 OG 圖。字型是預先子集化的 TTF（satori 不支援 woff2 與可變字型）
export default async function OpengraphImage() {
  const dir = join(process.cwd(), "app/fonts");
  const [mono, huninn] = await Promise.all([
    readFile(join(dir, "og-geist-mono.ttf")),
    readFile(join(dir, "og-huninn.ttf")),
  ]);
  const dots = Array.from({ length: 14 * 8 }, (_, i) => i);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: "#0f131c",
        color: "#f1efe7",
        fontFamily: "Huninn",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          right: 70,
          top: 90,
          display: "flex",
          flexWrap: "wrap",
          width: 14 * 26,
          gap: 12,
          opacity: 0.5,
        }}
      >
        {dots.map((i) => (
          <div
            key={i}
            style={{
              width: 8,
              height: 8,
              borderRadius: 8,
              background: i % 9 === 0 ? "#e24d34" : i % 4 === 0 ? "#7ea2ff" : "#2c3446",
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <svg width="64" height="64" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M4 4h11a12 12 0 0 1 0 24H4zM8 10v12h3V10z" fill="#7ea2ff" fillRule="evenodd" />
          <circle cx="27.5" cy="25" r="3.5" fill="#e24d34" />
        </svg>
        <span style={{ fontFamily: "GeistMono", fontSize: 30, color: "#9aa3b5" }}>
          $ claim you.dev-in.tw
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            fontFamily: "GeistMono",
            fontSize: 150,
            letterSpacing: -6,
            lineHeight: 1,
            display: "flex",
          }}
        >
          DEV-IN<span style={{ color: "#e24d34" }}>.</span>TW
        </div>
        <div style={{ fontSize: 64, color: "#7ea2ff", marginTop: 24 }}>給臺灣開發者的一個名字</div>
      </div>
      <div style={{ fontSize: 30, color: "#9aa3b5" }}>免費子網域 · 用 GitHub 登入 · 不收個資</div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "GeistMono", data: mono, weight: 700, style: "normal" },
        { name: "Huninn", data: huninn, weight: 400, style: "normal" },
      ],
    },
  );
}
