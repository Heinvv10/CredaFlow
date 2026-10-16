import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[var(--cf-brand)] text-[var(--cf-on-brand)]",
        secondary:
          "border-transparent bg-[var(--cf-bg-subtle)] text-[var(--cf-text-secondary)]",
        destructive:
          "border-transparent bg-[rgba(208,92,75,0.16)] text-[var(--cf-danger)]",
        outline: "border-[var(--cf-border-subtle)] text-[var(--cf-text-secondary)]",
        success: "border-transparent bg-[rgba(63,191,127,0.14)] text-[var(--cf-success)]",
        warning: "border-transparent bg-[rgba(217,154,58,0.15)] text-[var(--cf-warning)]",
        danger: "border-transparent bg-[rgba(208,92,75,0.16)] text-[var(--cf-danger)]",
        info: "border-transparent bg-[rgba(111,159,203,0.14)] text-[var(--cf-info)]",
        neutral: "border-transparent bg-[var(--cf-surface-strong)] text-[var(--cf-text-muted)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

// A span, not a div: badges sit inside <p> text (the client page's
// compliance status, the comms agent roster), where a div is invalid HTML and
// React reports it as a hydration error. inline-flex makes the two render alike.
function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
