import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 色彩 token 對比檢查（PLAN §4.2、§4.5）：直接讀 globals.css 的 OKLCH 值換算成 sRGB，
 * 淺色與深色都要過 WCAG 2.2 AA（文字 4.5:1、UI 元件與大字 3:1）。
 */
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g))
    if (m[1] && m[2]) out[m[1]] = m[2].trim();
  return out;
}

const light = block(":root");
const dark = { ...light, ...block(".dark") };

function resolve(tokens: Record<string, string>, name: string): string {
  let value = tokens[name] ?? "";
  for (let i = 0; i < 5 && value.startsWith("var("); i++) value = tokens[value.slice(6, -1)] ?? "";
  return value;
}

function oklchToLinearRgb(value: string): [number, number, number] {
  const m = value.match(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/);
  if (!m) throw new Error(`not oklch: ${value}`);
  const [L, C, H] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
  ];
}

function luminance(value: string): number {
  const [r, g, b] = oklchToLinearRgb(value);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const TEXT_PAIRS: [fg: string, bg: string][] = [
  ["ink", "bg"],
  ["ink", "surface"],
  ["ink-muted", "bg"],
  ["ink-muted", "surface"],
  ["ink-muted", "surface-2"],
  ["magpie", "bg"],
  ["magpie", "surface"],
  ["magpie", "magpie-soft"],
  ["beak", "bg"],
  ["signal", "bg"],
  ["signal", "signal-soft"],
  ["amber", "bg"],
  ["amber", "amber-soft"],
  ["danger", "bg"],
  ["danger", "danger-soft"],
  ["primary-fg", "primary"],
  ["ink", "magpie-soft"],
  ["ink", "amber-soft"],
  ["ink", "danger-soft"],
];

const UI_PAIRS: [fg: string, bg: string][] = [
  ["field", "bg"],
  ["focus", "bg"],
  ["magpie", "surface-2"],
];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme contrast", (_, tokens) => {
  it.each(TEXT_PAIRS)("text %s on %s ≥ 4.5:1", (fg, bg) => {
    expect(contrast(resolve(tokens, fg), resolve(tokens, bg))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(UI_PAIRS)("ui %s on %s ≥ 3:1", (fg, bg) => {
    expect(contrast(resolve(tokens, fg), resolve(tokens, bg))).toBeGreaterThanOrEqual(3);
  });
  it("ink reaches 12:1 on the page background", () => {
    expect(contrast(resolve(tokens, "ink"), resolve(tokens, "bg"))).toBeGreaterThanOrEqual(12);
  });
});
