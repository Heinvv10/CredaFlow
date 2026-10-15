import { Check } from "lucide-react"
import type { RecoveryRoute, RecoveryStatus } from "@prisma/client"
import { recoveryStepper } from "./recovery-model"

const stepClass = {
  done: "border-[var(--cf-success)] text-[var(--cf-text)]",
  current: "border-[var(--cf-brand)] bg-[var(--cf-surface-soft)] font-semibold text-[var(--cf-text)]",
  todo: "border-[var(--cf-border-subtle)] text-[var(--cf-text-muted)]",
}

/** The route's path with the current step marked: an NCA route shows its notice steps, a non-NCA route skips them. */
export function RecoveryStepper({ route, status }: { route: RecoveryRoute; status: RecoveryStatus }) {
  const steps = recoveryStepper(route, status)
  if (!steps) return null
  return (
    <ol aria-label="Recovery progress" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {steps.map((step, index) => (
        <li key={step.key} aria-current={step.state === "current" ? "step" : undefined}
          className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${stepClass[step.state]}`}>
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current text-[10px]">
            {step.state === "done" ? <Check className="h-3 w-3 text-[var(--cf-success)]" /> : index + 1}
          </span>
          <span className="min-w-0 break-words">{step.label}</span>
        </li>
      ))}
    </ol>
  )
}
