import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatIsoDate } from "@/lib/asset-finance/format"
import type { LegalMatterView } from "@/lib/asset-finance/legal-matter-view"
import { correctedStepIds, STEP_LABELS } from "./legal-matter-form"

const link = "text-[var(--cf-text-secondary)] underline underline-offset-2 hover:text-[var(--cf-text)]"

/** The matter's steps, oldest first; a step a later one corrects is marked and muted, and the correcting step names it. */
export function LegalStepsTimeline({ matter }: { matter: LegalMatterView }) {
  if (matter.steps.length === 0) return <p className="text-sm text-[var(--cf-text-muted)]">No step has been recorded.</p>
  const corrected = correctedStepIds(matter.steps)
  const byId = new Map(matter.steps.map((step) => [step.id, step]))
  return (
    <ol className="space-y-3">
      {matter.steps.map((step) => {
        const replaced = corrected.has(step.id)
        const target = step.correctsStepId ? byId.get(step.correctsStepId) : undefined
        return (
          <li key={step.id} className="rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className={`text-sm font-semibold ${replaced ? "text-[var(--cf-text-muted)] line-through" : "text-[var(--cf-text)]"}`}>
                {STEP_LABELS[step.kind]}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {replaced && <StatusPill tone="warning">Corrected</StatusPill>}
                <span className="whitespace-nowrap text-xs text-[var(--cf-text-muted)]">{formatIsoDate(step.stepDate)}</span>
              </div>
            </div>
            {target && (
              <p className="mt-1 text-xs text-[var(--cf-text-muted)]">Corrects: {STEP_LABELS[target.kind]} of {formatIsoDate(target.stepDate)}</p>
            )}
            {step.note && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--cf-text-secondary)]">{step.note}</p>}
            {step.hasEvidence && (
              <p className="mt-1 text-sm">
                <a className={link} href={`/api/asset-finance/legal-matters/${matter.id}/steps/${step.id}/document`} target="_blank" rel="noopener noreferrer">
                  Evidence
                </a>
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}
