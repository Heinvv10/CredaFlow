import { cn } from "@/lib/utils"

type PremiumTableShellProps = {
  children: React.ReactNode
  className?: string
}

export function PremiumTableShell({ children, className }: PremiumTableShellProps) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)]", className)}>
      <div className="overflow-x-auto">{children}</div>
    </div>
  )
}
