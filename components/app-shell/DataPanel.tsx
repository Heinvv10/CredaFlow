import { cn } from "@/lib/utils"

type DataPanelProps = {
  title?: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
  variant?: "default" | "raised" | "subtle" | "accent"
  density?: "default" | "compact" | "loose"
}

const variantClass = {
  default: "border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)]",
  raised: "border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] shadow-[var(--cf-shadow-panel)]",
  subtle: "border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)]",
  accent: "border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.08)]",
}

const densityClass = {
  default: "p-4",
  compact: "p-3",
  loose: "p-5 lg:p-6",
}

export function DataPanel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  variant = "default",
  density = "default",
}: DataPanelProps) {
  return (
    <section className={cn("min-w-0 overflow-hidden rounded-lg border", variantClass[variant], className)}>
      {(title || description || actions) && (
        <div className="flex min-w-0 flex-col gap-3 border-b border-[var(--cf-border-subtle)] px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-[var(--cf-text)]">{title}</h2>}
            {description && <p className="mt-1 text-xs text-[var(--cf-text-muted)]">{description}</p>}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
      )}
      <div className={cn("min-w-0", densityClass[density], bodyClassName)}>{children}</div>
    </section>
  )
}
