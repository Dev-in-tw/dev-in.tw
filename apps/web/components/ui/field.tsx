import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

const base =
  "w-full rounded-md border border-field bg-bg px-3 text-ink transition-[border-color,box-shadow] duration-150 placeholder:text-ink-muted hover:border-ink focus-visible:border-magpie focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-magpie/40 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/30";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(base, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(base, "min-h-24 py-2 leading-relaxed", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        base,
        "h-10 appearance-none bg-[length:12px] bg-[right_0.75rem_center] bg-no-repeat pr-8",
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.5'/%3E%3C/svg%3E\")]",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor 由呼叫端提供
  return <label className={cn("text-sm font-medium text-ink", className)} {...props} />;
}

export function FieldHint({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <p id={id} className={cn("text-sm text-ink-muted", className)}>
      {children}
    </p>
  );
}

export function FieldError({ id, children }: { id?: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="text-sm font-medium text-danger">
      {children}
    </p>
  );
}

export function Checkbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-5 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-field bg-bg transition-colors checked:border-magpie checked:bg-magpie checked:bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='white' stroke-width='2'/%3E%3C/svg%3E\")] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-magpie",
        className,
      )}
      {...props}
    />
  );
}
