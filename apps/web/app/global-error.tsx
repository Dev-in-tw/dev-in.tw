"use client";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="zh-Hant">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          maxWidth: 560,
          margin: "6rem auto",
          padding: "0 1rem",
          lineHeight: 1.7,
        }}
      >
        <p style={{ fontFamily: "ui-monospace, monospace", color: "#666" }}>;; status: SERVFAIL</p>
        <h1>Dev-in.tw 暫時無法載入</h1>
        <p>請重新整理頁面。如果持續發生，請寫信到 hello@dev-in.tw。</p>
        <button type="button" onClick={reset} style={{ padding: ".6rem 1rem", font: "inherit" }}>
          再試一次
        </button>
      </body>
    </html>
  );
}
