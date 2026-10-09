import { AlertCircle, CheckCircle2, Info, ShieldAlert } from "lucide-react"
import { cn } from "@/lib/utils"

const variants = {
  default: {
    icon: Info,
    className: "border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] text-[var(--cf-text-muted)]",
  },
  warning: {
    icon: AlertCircle,
    className: "border-amber-500/30 bg-amber-500/10 text-[var(--cf-warning)]",
  },
  success: {
    icon: CheckCircle2,
    className: "border-emerald-500/25 bg-emerald-500/10 text-[var(--cf-success)]",
  },
  danger: {
    icon: ShieldAlert,
    className: "border-red-500/30 bg-red-500/10 text-[var(--cf-danger)]",
  },
}

type InfoStripProps = {
  variant?: keyof typeof variants
  children: React.ReactNode
  actions?: React.ReactNode
  className?: string
}

export function InfoStrip({ variant = "default", children, actions, className }: InfoStripProps) {
  const Icon = variants[variant].icon
  return (
    <div className={cn("flex items-start justify-between gap-3 rounded-md border px-4 py-3 text-sm", variants[variant].className, className)}>
      <div className="flex min-w-0 items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 leading-5">{children}</div>
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  )
}
