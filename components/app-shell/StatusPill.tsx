import { cn } from "@/lib/utils"

type StatusTone = "neutral" | "success" | "warning" | "danger" | "info" | "bronze"

type StatusPillProps = {
  children: React.ReactNode
  tone?: StatusTone
  className?: string
}

const toneClass: Record<StatusTone, string> = {
  neutral: "border-[var(--cf-border-subtle)] bg-[var(--cf-surface-hover)] text-[var(--cf-text-secondary)]",
  success: "border-[rgba(63,191,127,0.28)] bg-[rgba(63,191,127,0.12)] text-[var(--cf-success)]",
  warning: "border-[rgba(217,154,58,0.32)] bg-[rgba(217,154,58,0.12)] text-[var(--cf-warning)]",
  danger: "border-[rgba(208,92,75,0.32)] bg-[rgba(208,92,75,0.12)] text-[var(--cf-danger)]",
  info: "border-[rgba(111,159,203,0.32)] bg-[rgba(111,159,203,0.12)] text-[var(--cf-info)]",
  bronze: "border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.14)] text-[var(--cf-brand-soft)]",
}

export function StatusPill({ children, tone = "neutral", className }: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em]",
        toneClass[tone],
        className
      )}
    >
      {children}
    </span>
  )
}
