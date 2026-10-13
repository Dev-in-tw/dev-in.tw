"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn.ts";

/**
 * 台灣點陣地圖（§4.4 #2）：約 2,600 個點（Natural Earth 10m，含澎湖、金門、馬祖、蘭嶼、綠島），
 * WebGL2 point sprites 一次 draw call；不支援時退回 Canvas2D。
 *
 * - 每個公開成員以 hash(name) 對應到一個點並點亮；最新加入的成員依序產生 ripple（約 4 秒內結束，
 *   不是無限循環，因此不需要暫停控制）。
 * - 滑鼠視差 ≤ 8px；離開視窗或分頁隱藏時停止繪製；DPR 上限 1.5。
 * - reduced-motion：只畫一張靜態畫面，沒有 ripple 與視差。
 */

const LON0 = 118;
const LAT0 = 21.8;
const MAX_RIPPLES = 8;

export function hashName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

let dotsPromise: Promise<Float32Array> | null = null;
function loadDots(): Promise<Float32Array> {
  dotsPromise ??= fetch("/taiwan-dots.bin")
    .then((r) => r.arrayBuffer())
    .then((buf) => {
      const raw = new Uint16Array(buf);
      const out = new Float32Array(raw.length);
      const k = Math.cos((23.7 * Math.PI) / 180); // 經度依緯度縮放，避免台灣被拉寬
      for (let i = 0; i < raw.length; i += 2) {
        out[i] = ((raw[i] ?? 0) / 1000 + LON0) * k;
        out[i + 1] = (raw[i + 1] ?? 0) / 1000 + LAT0;
      }
      return out;
    });
  return dotsPromise;
}

function readColor(cssVar: string): [number, number, number] {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [0.5, 0.5, 0.5];
  ctx.fillStyle =
    getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim() || "#888";
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [(d[0] ?? 0) / 255, (d[1] ?? 0) / 255, (d[2] ?? 0) / 255];
}

const VS = `#version 300 es
in vec2 a_pos;
in float a_lit;
in float a_depth;
uniform vec4 u_bounds; // minX, minY, maxX, maxY
uniform vec2 u_size;   // canvas css px
uniform float u_scale; // px per degree
uniform vec2 u_offset; // centering offset in px
uniform vec2 u_parallax;
uniform float u_dpr;
uniform vec4 u_ripples[${MAX_RIPPLES}]; // x, y, startTime, strength
uniform float u_time;
uniform float u_highlight;
out float v_lit;
out float v_wave;
out float v_hi;
void main() {
  vec2 px = vec2((a_pos.x - u_bounds.x) * u_scale, (u_bounds.w - a_pos.y) * u_scale) + u_offset;
  px += u_parallax * a_depth;
  float wave = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = u_ripples[i];
    if (r.w <= 0.0) continue;
    float t = u_time - r.z;
    if (t < 0.0 || t > 2.2) continue;
    float radius = t * 0.45;
    float d = distance(a_pos, r.xy);
    float ring = 1.0 - smoothstep(0.0, 0.07, abs(d - radius));
    wave = max(wave, ring * (1.0 - t / 2.2) * r.w);
  }
  v_lit = a_lit;
  v_wave = wave;
  v_hi = gl_VertexID == int(u_highlight) ? 1.0 : 0.0;
  vec2 clip = (px / u_size) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  float base = u_scale * 0.019;
  gl_PointSize = (base * (1.0 + 0.6 * wave) + (a_lit > 0.5 ? base * 0.35 : 0.0) + v_hi * base * 0.9) * u_dpr;
}`;

const FS = `#version 300 es
precision mediump float;
in float v_lit;
in float v_wave;
in float v_hi;
uniform vec3 u_dot;
uniform vec3 u_lit;
uniform vec3 u_accent;
out vec4 color;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float edge = 1.0 - smoothstep(0.38, 0.5, d);
  vec3 col = mix(u_dot, u_lit, step(0.5, v_lit));
  col = mix(col, u_accent, max(v_wave * 0.85, v_hi));
  float alpha = mix(0.55, 1.0, max(step(0.5, v_lit), v_wave));
  color = vec4(col, alpha * edge);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type);
  if (!s) throw new Error("shader");
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "");
  return s;
}

export function TaiwanMap({
  members = [],
  latest = [],
  highlight,
  className,
  reducedMotion = false,
}: {
  members?: string[];
  latest?: string[];
  highlight?: string | null;
  className?: string;
  reducedMotion?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const highlightRef = useRef<string | null | undefined>(highlight);
  highlightRef.current = highlight;
  const redraw = useRef<() => void>(() => {});

  // biome-ignore lint/correctness/useExhaustiveDependencies: highlight 透過 ref 讀取，這裡只用來觸發重繪
  useEffect(() => {
    redraw.current();
  }, [highlight]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 成員名單以內容比對，避免每次 render 重建 GL context
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let raf = 0;
    let visible = true;
    const cleanups: (() => void)[] = [];

    loadDots().then((dots) => {
      if (disposed) return;
      const count = dots.length / 2;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < dots.length; i += 2) {
        const x = dots[i] ?? 0;
        const y = dots[i + 1] ?? 0;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      const indexOf = (name: string) => hashName(name) % count;
      const lit = new Float32Array(count);
      for (const name of members) lit[indexOf(name)] = 1;
      const hiIndex = (name: string | null | undefined) => (name ? indexOf(name) : -1);
      const depth = new Float32Array(count);
      for (let i = 0; i < count; i++) depth[i] = ((hashName(String(i)) % 1000) / 1000) * 0.8 + 0.2;

      const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      let cssW = 0;
      let cssH = 0;
      let scale = 1;
      let offset: [number, number] = [0, 0];
      const parallax: [number, number] = [0, 0];
      const target: [number, number] = [0, 0];

      const layout = () => {
        const rect = canvas.getBoundingClientRect();
        cssW = rect.width;
        cssH = rect.height;
        canvas.width = Math.max(1, Math.round(cssW * dpr));
        canvas.height = Math.max(1, Math.round(cssH * dpr));
        const pad = 16;
        scale = Math.min((cssW - pad * 2) / (maxX - minX), (cssH - pad * 2) / (maxY - minY));
        offset = [(cssW - (maxX - minX) * scale) / 2, (cssH - (maxY - minY) * scale) / 2];
      };

      const t0 = performance.now();
      const ripples = new Float32Array(MAX_RIPPLES * 4);
      latest.slice(0, MAX_RIPPLES).forEach((name, i) => {
        const idx = indexOf(name);
        ripples.set(
          [dots[idx * 2] ?? 0, dots[idx * 2 + 1] ?? 0, 0.4 + i * 0.35, reducedMotion ? 0 : 1],
          i * 4,
        );
      });
      const rippleEnd = 0.4 + Math.min(latest.length, MAX_RIPPLES) * 0.35 + 2.3;

      if (!gl) {
        // Canvas2D 退路：靜態畫面
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const draw2d = () => {
          layout();
          const dot = readColor("--rule");
          const on = readColor("--magpie");
          const accent = readColor("--beak");
          const hi = hiIndex(highlightRef.current);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, cssW, cssH);
          const r = scale * 0.0095;
          for (let i = 0; i < count; i++) {
            const isLit = (lit[i] ?? 0) > 0.5;
            const c = i === hi ? accent : isLit ? on : dot;
            ctx.fillStyle = `rgb(${c[0] * 255} ${c[1] * 255} ${c[2] * 255})`;
            ctx.beginPath();
            ctx.arc(
              ((dots[i * 2] ?? 0) - minX) * scale + offset[0],
              (maxY - (dots[i * 2 + 1] ?? 0)) * scale + offset[1],
              isLit ? r * 1.4 : r,
              0,
              Math.PI * 2,
            );
            ctx.fill();
          }
        };
        draw2d();
        redraw.current = draw2d;
        return;
      }

      const program = gl.createProgram();
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(program);
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL 的 useProgram，不是 React hook
      gl.useProgram(program);

      const attr = (name: string, data: Float32Array, size: number) => {
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(program, name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      };
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      attr("a_pos", dots, 2);
      attr("a_lit", lit, 1);
      attr("a_depth", depth, 1);

      const u = (name: string) => gl.getUniformLocation(program, name);
      const uBounds = u("u_bounds");
      const uSize = u("u_size");
      const uScale = u("u_scale");
      const uOffset = u("u_offset");
      const uParallax = u("u_parallax");
      const uDpr = u("u_dpr");
      const uRipples = u("u_ripples");
      const uTime = u("u_time");
      const uHighlight = u("u_highlight");
      const uDot = u("u_dot");
      const uLit = u("u_lit");
      const uAccent = u("u_accent");

      const setColors = () => {
        gl.uniform3fv(uDot, readColor("--field"));
        gl.uniform3fv(uLit, readColor("--magpie"));
        gl.uniform3fv(uAccent, readColor("--beak"));
      };
      setColors();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      const draw = (now: number) => {
        const time = (now - t0) / 1000;
        parallax[0] += (target[0] - parallax[0]) * 0.08;
        parallax[1] += (target[1] - parallax[1]) * 0.08;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform4f(uBounds, minX, minY, maxX, maxY);
        gl.uniform2f(uSize, cssW, cssH);
        gl.uniform1f(uScale, scale);
        gl.uniform2f(uOffset, offset[0], offset[1]);
        gl.uniform2f(uParallax, parallax[0], parallax[1]);
        gl.uniform1f(uDpr, dpr);
        gl.uniform4fv(uRipples, ripples);
        gl.uniform1f(uTime, time);
        gl.uniform1f(uHighlight, hiIndex(highlightRef.current));
        gl.drawArrays(gl.POINTS, 0, count);
        const settling =
          Math.abs(target[0] - parallax[0]) > 0.05 || Math.abs(target[1] - parallax[1]) > 0.05;
        if (!reducedMotion && visible && !document.hidden && (time < rippleEnd || settling)) {
          raf = requestAnimationFrame(draw);
        } else {
          raf = 0;
        }
      };
      const kick = () => {
        if (!raf) raf = requestAnimationFrame(draw);
      };
      redraw.current = kick;

      layout();
      kick();

      const ro = new ResizeObserver(() => {
        layout();
        kick();
      });
      ro.observe(canvas);
      cleanups.push(() => ro.disconnect());

      const io = new IntersectionObserver(([entry]) => {
        visible = Boolean(entry?.isIntersecting);
        if (visible) kick();
      });
      io.observe(canvas);
      cleanups.push(() => io.disconnect());

      const onVisibility = () => {
        if (!document.hidden) kick();
      };
      document.addEventListener("visibilitychange", onVisibility);
      cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));

      const themeObserver = new MutationObserver(() => {
        setColors();
        kick();
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      cleanups.push(() => themeObserver.disconnect());

      if (!reducedMotion && matchMedia("(hover: hover) and (pointer: fine)").matches) {
        const onMove = (e: PointerEvent) => {
          const nx = e.clientX / window.innerWidth - 0.5;
          const ny = e.clientY / window.innerHeight - 0.5;
          target[0] = -nx * 16; // 乘上 depth（≤ 1）後最多 8px
          target[1] = -ny * 16;
          kick();
        };
        window.addEventListener("pointermove", onMove, { passive: true });
        cleanups.push(() => window.removeEventListener("pointermove", onMove));
      }

      cleanups.push(() => {
        gl.deleteProgram(program);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      });
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      for (const fn of cleanups) fn();
    };
  }, [members.join(","), latest.join(","), reducedMotion]);

  return <canvas ref={canvasRef} aria-hidden className={cn("block size-full", className)} />;
}
