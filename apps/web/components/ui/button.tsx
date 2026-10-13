import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn.ts";

/**
 * 主要按鈕實心鵲藍，hover 時底線轉成鵲喙紅；次要按鈕只有外框；
 * 危險按鈕用 danger 外框，確認對話框內才是實心（PLAN §4.2）。
 */
export const buttonVariants = cva(
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[background-color,color,box-shadow,translate] duration-200 ease-out focus-visible:outline-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-fg shadow-[inset_0_-2px_0_transparent] hover:shadow-[inset_0_-3px_0_var(--beak)] active:translate-y-px",
        secondary:
          "border border-field bg-bg text-ink hover:border-ink hover:bg-surface active:translate-y-px",
        ghost: "text-ink hover:bg-surface-2",
        danger: "border border-danger text-danger hover:bg-danger-soft",
        "danger-solid": "bg-danger text-white hover:bg-[color-mix(in_oklch,var(--danger)_85%,black)]",
        link: "h-auto px-0 text-magpie underline decoration-1 underline-offset-4 hover:decoration-beak",
      },
      size: {
        sm: "h-8 px-3 text-sm",
        md: "h-10 px-4 text-[0.95rem]",
        lg: "h-12 px-6 text-base",
        icon: "size-9",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      {...(asChild ? {} : { type: type ?? "button" })}
      {...props}
    />
  );
}
