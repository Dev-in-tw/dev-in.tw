"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { q } from "@/lib/queries.ts";

/** Odometer 統計數字（§4.4 #10）：進入視窗時才用 @property 轉到目標值，純 CSS */
export function Stats() {
  const { data } = useQuery(q.stats());
  const ref = useRef<HTMLDListElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setOn(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const items = [
    { label: "已開通的子網域", value: data?.subdomains, unit: "個" },
    { label: "成員", value: data?.members, unit: "位" },
    { label: "DNS 紀錄", value: data?.records, unit: "筆" },
  ];

  return (
    <section aria-label="統計數字" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <dl
        ref={ref}
        className="grid gap-px overflow-hidden rounded-md border border-rule bg-rule sm:grid-cols-3"
      >
        {items.map((item) => (
          <div key={item.label} className="bg-bg px-6 py-8">
            <dt className="zone text-sm text-ink-muted">
              <span className="text-beak">;</span> {item.label}
            </dt>
            <dd className="zone mt-2 flex items-baseline gap-2 text-step-5 font-semibold tracking-tight">
              {item.value === undefined ? (
                <span className="text-rule">———</span>
              ) : (
                <>
                  <span
                    className="odometer"
                    data-on={on}
                    style={{ ["--target" as string]: item.value }}
                    aria-hidden
                  />
                  <span className="sr-only">{item.value}</span>
                </>
              )}
              <span className="text-step-0 font-normal text-ink-muted">{item.unit}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
