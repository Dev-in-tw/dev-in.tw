"use client";

import { useEffect, useState } from "react";

/** 逐字顯示：每字 8ms，總長上限 200ms；reduced-motion 時直接顯示全文 */
export function Typewriter({ text, reduced }: { text: string; reduced: boolean }) {
  const [shown, setShown] = useState(reduced ? text.length : 0);

  useEffect(() => {
    if (reduced) {
      setShown(text.length);
      return;
    }
    setShown(0);
    const per = Math.min(8, 200 / Math.max(text.length, 1));
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const n = Math.min(text.length, Math.floor((now - start) / per) + 1);
      setShown(n);
      if (n < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, reduced]);

  return (
    <>
      {text.slice(0, shown)}
      {shown < text.length ? <span className="opacity-0">{text.slice(shown)}</span> : null}
    </>
  );
}
