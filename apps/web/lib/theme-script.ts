/**
 * 在第一次繪製前套用主題，避免閃爍。內容必須固定不變：proxy.ts 會算出它的 sha256，
 * 放進 nonce CSP 的 script-src（nonce 頁面不能用 'unsafe-inline'）。
 */
export const THEME_STORAGE_KEY = "dit-theme";

export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;
