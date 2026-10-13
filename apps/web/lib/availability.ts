import type { Availability, AvailabilityStatus } from "@dit/contract";

/**
 * 可用性查詢的狀態機（§4.4 #1）。純函式，元件只負責把事件送進來：
 *
 *   idle ──input──▶ typing ──debounce──▶ checking ──result──▶ result
 *     ▲                │                    │  └───error───▶ error
 *     └────clear───────┴────────────────────┘
 *
 * 每次 input 會遞增 seq；晚到的舊回應（seq 不符）一律丟掉，避免結果跳回上一個名字。
 */
export type AvailabilityState =
  | { phase: "idle"; name: ""; seq: number }
  | { phase: "typing"; name: string; seq: number }
  | { phase: "checking"; name: string; seq: number }
  | { phase: "result"; name: string; seq: number; result: Availability }
  | { phase: "error"; name: string; seq: number; message: string };

export type AvailabilityEvent =
  | { type: "input"; value: string }
  | { type: "check"; seq: number }
  | { type: "result"; seq: number; result: Availability }
  | { type: "error"; seq: number; message: string };

export const initialAvailability: AvailabilityState = { phase: "idle", name: "", seq: 0 };

/** 輸入正規化：trim、轉小寫、全形英數轉半形、空白與底線換成連字號、去掉 .dev-in.tw 後綴 */
export function normalizeInput(raw: string): string {
  return raw
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\.dev-in\.tw\.?$/, "")
    .replace(/^https?:\/\//, "")
    .replace(/[\s_]+/g, "-")
    .slice(0, 63);
}

export function availabilityReducer(
  state: AvailabilityState,
  event: AvailabilityEvent,
): AvailabilityState {
  switch (event.type) {
    case "input": {
      const name = normalizeInput(event.value);
      const seq = state.seq + 1;
      if (!name) return { phase: "idle", name: "", seq };
      return { phase: "typing", name, seq };
    }
    case "check":
      if (state.phase !== "typing" || event.seq !== state.seq) return state;
      return { phase: "checking", name: state.name, seq: state.seq };
    case "result":
      if (event.seq !== state.seq || state.phase === "idle") return state;
      return { phase: "result", name: state.name, seq: state.seq, result: event.result };
    case "error":
      if (event.seq !== state.seq || state.phase === "idle") return state;
      return { phase: "error", name: state.name, seq: state.seq, message: event.message };
  }
}

/** 可以直接進入申請流程的狀態 */
export function isClaimable(status: AvailabilityStatus): boolean {
  return status === "available" || status === "review";
}

export type Tone = "ok" | "warn" | "no" | "idle";

export function toneOf(status: AvailabilityStatus): Tone {
  if (status === "available") return "ok";
  if (status === "review" || status === "cooldown" || status === "capacity_full") return "warn";
  return "no";
}
