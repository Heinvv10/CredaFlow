import { cn } from "@/lib/utils"

type MetricCardProps = {
  label: string
  value: React.ReactNode
  detail?: React.ReactNode
  tone?: "neutral" | "success" | "warning" | "danger" | "info"
  className?: string
}

const toneClass = {
  neutral: "border-[var(--cf-border-subtle)]",
  success: "border-[rgba(63,191,127,0.34)]",
  warning: "border-[rgba(217,154,58,0.36)]",
  danger: "border-[rgba(208,92,75,0.36)]",
  info: "border-[rgba(111,159,203,0.34)]",
}

export function MetricCard({ label, value, detail, tone = "neutral", className }: MetricCardProps) {
  return (
    <div className={cn("rounded-lg border bg-[var(--cf-bg-panel)] p-4 shadow-[var(--cf-shadow-card)]", toneClass[tone], className)}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--cf-text-muted)]">{label}</p>
      <div className="mt-2 whitespace-nowrap text-2xl font-semibold tabular-nums text-[var(--cf-text)]">{value}</div>
      {detail && <div className="mt-2 text-xs text-[var(--cf-text-muted)]">{detail}</div>}
    </div>
  )
}
