import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--cf-bg)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-[var(--cf-brand)] text-[var(--cf-on-brand)] hover:bg-[var(--cf-brand-alt)]",
        destructive: "bg-[var(--cf-danger)] text-white hover:brightness-110",
        outline:
          "border border-[var(--cf-border-strong)] bg-transparent text-[var(--cf-text)] hover:bg-[rgba(79,70,229,0.08)]",
        secondary:
          "bg-[var(--cf-bg-subtle)] text-[var(--cf-text)] hover:bg-[var(--cf-bg-raised)]",
        ghost: "text-[var(--cf-text-secondary)] hover:bg-[var(--cf-surface-hover)] hover:text-[var(--cf-text)]",
        link: "text-[var(--cf-brand-soft)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
