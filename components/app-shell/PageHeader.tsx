import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import type { Crumb } from "@/lib/nav/breadcrumbs"

type PageHeaderProps = {
  eyebrow?: string
  title: string
  description?: string
  actions?: React.ReactNode
  breadcrumbs?: Crumb[]
}

export function PageHeader({ eyebrow, title, description, actions, breadcrumbs }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-4 border-b border-[var(--cf-border-subtle)] px-4 py-5 lg:flex-row lg:items-end lg:justify-between lg:px-8">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 1 && (
          <div className="mb-3">
            <Breadcrumbs items={breadcrumbs} />
          </div>
        )}
        {eyebrow && (
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-brand)]">
            {eyebrow}
          </p>
        )}
        <h1 className="break-words text-2xl font-semibold text-[var(--cf-text)]" title={title}>{title}</h1>
        {description && (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--cf-text-muted)]">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
