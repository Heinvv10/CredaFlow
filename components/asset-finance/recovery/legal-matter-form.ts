import { formatIsoDate } from "@/lib/asset-finance/format"
import { effectiveSteps, LEGAL_STEP_KINDS, type LegalRegime, type LegalStepHint, type LegalStepKind } from "@/lib/asset-finance/legal-matter-hint"
import type { EligibleSection129Record, LegalMatterView } from "@/lib/asset-finance/legal-matter-view"

// Labels and the form-to-request mapping of the staff legal-matter panel.
// Presentation only: the rules (what a step may follow, which dates are
// admitted) are enforced by lib/asset-finance/legal-matter-*.ts and the database.

export const STEP_LABELS: Record<LegalStepKind, string> = {
  LETTER_OF_DEMAND: "Letter of demand",
  S129_SENT: "Section 129 notice sent",
  SUMMONS_ISSUED: "Summons issued",
  SUMMONS_SERVED: "Summons served",
  JUDGMENT: "Judgment",
  ATTACHMENT_ORDER: "Attachment order",
  SHERIFF_RETURN: "Sheriff's return",
  ASSET_RECOVERED: "Asset recovered",
  SETTLED: "Settled",
  WITHDRAWN: "Withdrawn",
}

export const REGIME_LABELS: Record<LegalRegime, string> = { NCA: "NCA", NON_NCA: "Non-NCA" }

type StepRow = LegalMatterView["steps"][number]

/** The kinds a matter's step can have; a section 129 step needs an NCA notice record, so a non-NCA matter has none. */
export function stepKindsFor(regime: LegalRegime): LegalStepKind[] {
  return LEGAL_STEP_KINDS.filter((kind) => regime === "NCA" || kind !== "S129_SENT")
}

/** "Summons may issue from 2026-10-30" with the date printed as the app prints dates. */
export function hintText(hint: LegalStepHint): string {
  const text = hint.date ? hint.text.replace(hint.date, formatIsoDate(hint.date)) : hint.text
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Step ids that a later step corrects (shown as corrected on the timeline). */
export function correctedStepIds(steps: readonly StepRow[]): Set<string> {
  return new Set(steps.flatMap((step) => (step.correctsStepId ? [step.correctsStepId] : [])))
}

/** The steps a new step can correct: the ones no other step has corrected yet. */
export function correctableSteps(steps: readonly StepRow[]): StepRow[] {
  const live = new Set(effectiveSteps(steps).map((step) => step.id))
  return steps.filter((step) => live.has(step.id))
}

/**
 * A section 129 record backs one step; only a correction may name it again
 * (legal-matter-step.ts), so a used record is offered only while correcting.
 */
export function recordSelectable(record: EligibleSection129Record, correctsStepId: string): boolean {
  return record.usedByStepId === null || correctsStepId !== ""
}

export function recordLabel(record: EligibleSection129Record): string {
  const when = record.completedOn ? `completed ${formatIsoDate(record.completedOn)}` : "completion date not recorded"
  return `Notice ${when}${record.usedByStepId ? " (already used)" : ""}`
}

export interface StepForm {
  kind: LegalStepKind
  stepDate: string
  note: string
  section129RecordId: string
  correctsStepId: string
  closeMatter: boolean
  location: string
  condition: string
  file: File | null
}

export const emptyStepForm = (today: string, kind: LegalStepKind): StepForm => ({
  kind, stepDate: today, note: "", section129RecordId: "", correctsStepId: "", closeMatter: false, location: "", condition: "", file: null,
})

/** The text fields the route reads, only those the chosen kind uses. */
export function stepFields(form: StepForm): Record<string, string> {
  const fields: Record<string, string> = { kind: form.kind, stepDate: form.stepDate }
  if (form.note.trim()) fields.note = form.note.trim()
  if (form.kind === "S129_SENT") fields.section129RecordId = form.section129RecordId
  if (form.correctsStepId) fields.correctsStepId = form.correctsStepId
  if ((form.kind === "SETTLED" || form.kind === "WITHDRAWN") && form.closeMatter) fields.closeMatter = "true"
  if (form.kind === "ASSET_RECOVERED") {
    fields.location = form.location.trim()
    fields.condition = form.condition.trim()
  }
  return fields
}

/** Multipart when the step carries an evidence file (the route reads `file`), JSON otherwise. */
export function stepBody(form: StepForm): FormData | Record<string, string> {
  const fields = stepFields(form)
  if (!form.file) return fields
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.append(key, value)
  data.append("file", form.file)
  return data
}

/** Catches what the form can know before the round trip; the route validates again. */
export function stepFormError(form: StepForm): string | null {
  if (!form.stepDate) return "Choose the date of the step"
  if (form.kind === "S129_SENT" && !form.section129RecordId) return "Choose the completed section 129 notice this step records"
  if (form.kind === "ASSET_RECOVERED" && (form.location.trim().length < 2 || form.condition.trim().length < 3)) {
    return "Describe where the asset is and its condition"
  }
  return null
}

/** A refusal as one line: the route's field messages when it has them, otherwise its error, verbatim. */
export function refusalText(error: string, fields: Record<string, string>): string {
  const messages = Object.values(fields)
  return messages.length > 0 ? messages.join("; ") : error
}
