interface StepBarProps {
  step: number
  labels: readonly string[]
}

export function StepBar({ step, labels }: StepBarProps) {
  return (
    <div className="flex items-center gap-2 mb-6" aria-label="Wizard progress">
      {labels.map((label, i) => {
        const s = i + 1
        const isCurrent = step === s
        const isDone = step > s
        return (
          <div
            key={s}
            className="flex items-center gap-2"
            aria-current={isCurrent ? "step" : undefined}
          >
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                isCurrent
                  ? "bg-[var(--cf-brand)] text-[var(--cf-on-brand)]"
                  : isDone
                    ? "bg-[var(--cf-success)] text-[var(--cf-bg)]"
                    : "bg-[var(--cf-bg-raised)] text-[var(--cf-text-muted)]"
              }`}
            >
              {isDone ? "✓" : s}
            </div>
            <span
              className={`text-xs font-medium ${
                step >= s ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"
              }`}
            >
              {label}
            </span>
            {s < labels.length && (
              <div className="w-8 h-px bg-[var(--cf-border-subtle)]" />
            )}
          </div>
        )
      })}
    </div>
  )
}
