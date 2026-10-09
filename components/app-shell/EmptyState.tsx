import { ArrowRight, type LucideIcon } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type EmptyStateProps = {
  icon?: LucideIcon
  title: string
  description: string
  action?: {
    label: string
    href: string
  }
  secondaryAction?: React.ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, secondaryAction, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-dashed border-[var(--cf-border-strong)] bg-[var(--cf-surface-soft)] px-6 py-10 text-center",
        className
      )}
    >
      {Icon && (
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] text-[var(--cf-brand-soft)]">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <h3 className="text-base font-semibold text-[var(--cf-text)]">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--cf-text-muted)]">{description}</p>
      {(action || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {action && (
            <Button asChild size="sm">
              <Link href={action.href}>
                {action.label}
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
          {secondaryAction}
        </div>
      )}
    </div>
  )
}
