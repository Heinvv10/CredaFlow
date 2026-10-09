import { cn } from "@/lib/utils"

type FormSectionProps = {
  number?: string
  title: string
  description?: string
  children: React.ReactNode
  className?: string
}

export function FormSection({ number, title, description, children, className }: FormSectionProps) {
  return (
    <section className={cn("rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-5 shadow-sm", className)}>
      <div className="mb-5 flex items-start gap-3">
        {number && (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--cf-brand)] text-xs font-bold text-[var(--cf-on-brand)]">
            {number}
          </span>
        )}
        <div>
          <h2 className="text-base font-semibold text-[var(--cf-text)]">{title}</h2>
          {description && <p className="mt-1 text-sm leading-5 text-[var(--cf-text-muted)]">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}
