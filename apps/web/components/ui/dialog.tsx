"use client";

import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  className,
  children,
  title,
  description,
  hideClose,
  ...props
}: ComponentProps<typeof D.Content> & { title: ReactNode; description?: ReactNode; hideClose?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className="enter-fade fixed inset-0 z-50 bg-[color-mix(in_oklch,var(--ink)_35%,transparent)] backdrop-blur-[1px]" />
      <D.Content
        className={cn(
          "enter-pop fixed top-1/2 left-1/2 z-50 w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-dialog)] border border-rule bg-bg p-6 shadow-[6px_6px_0_var(--shadow)] focus-visible:outline-none",
          className,
        )}
        {...(description ? {} : { "aria-describedby": undefined })}
        {...props}
      >
        <D.Title className="pr-8 text-step-1 font-semibold">{title}</D.Title>
        {description ? (
          <D.Description className="mt-1 text-sm text-ink-muted">{description}</D.Description>
        ) : null}
        <div className="mt-4">{children}</div>
        {hideClose ? null : (
          <D.Close
            className="absolute top-4 right-4 inline-flex size-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
            aria-label="關閉"
          >
            <X className="size-4" aria-hidden />
          </D.Close>
        )}
      </D.Content>
    </D.Portal>
  );
}

/** 手機底部 sheet（DNS 編輯器的新增列在手機上改用它） */
export function SheetContent({
  className,
  children,
  title,
  ...props
}: ComponentProps<typeof D.Content> & { title: ReactNode }) {
  return (
    <D.Portal>
      <D.Overlay className="enter-fade fixed inset-0 z-50 bg-[color-mix(in_oklch,var(--ink)_35%,transparent)]" />
      <D.Content
        aria-describedby={undefined}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-[var(--radius-dialog)] border-t border-rule bg-bg p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] transition-transform duration-300 ease-out [@starting-style]:translate-y-full",
          className,
        )}
        {...props}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-rule" aria-hidden />
        <D.Title className="text-step-1 font-semibold">{title}</D.Title>
        <div className="mt-4">{children}</div>
        <D.Close
          className="absolute top-4 right-4 inline-flex size-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2"
          aria-label="關閉"
        >
          <X className="size-4" aria-hidden />
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}
