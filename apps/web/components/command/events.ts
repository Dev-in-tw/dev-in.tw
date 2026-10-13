/** 指令面板以 DOM 事件開啟，讓任何地方（含 Server Component 裡的按鈕）都能叫出它 */
export const OPEN_EVENT = "dit:command-palette";

export function openCommandPalette(initial?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: initial ?? "" }));
}
