import type { ComponentProps } from "react";
import { cn } from "@/lib/cn.ts";

/** 印刷感卡片：1px rule 線條 + 4px 位移硬陰影，不用玻璃擬態 */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-md border border-rule bg-bg shadow-[4px_4px_0_var(--shadow)]", className)}
      {...props}
    />
  );
}

export function SectionTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("text-step-1 font-semibold tracking-tight", className)} {...props} />;
}

/** zone file 註解樣式的小標，例如 `; records` */
export function Eyebrow({ className, children, ...props }: ComponentProps<"p">) {
  return (
    <p className={cn("zone text-sm text-ink-muted", className)} {...props}>
      <span aria-hidden className="text-beak">
        ;{" "}
      </span>
      {children}
    </p>
  );
}
