import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"

export type LegalRegime = "NCA" | "NON_NCA"
export type LegalStepKind =
  | "LETTER_OF_DEMAND" | "S129_SENT" | "SUMMONS_ISSUED" | "SUMMONS_SERVED" | "JUDGMENT"
  | "ATTACHMENT_ORDER" | "SHERIFF_RETURN" | "ASSET_RECOVERED" | "SETTLED" | "WITHDRAWN"

export const LEGAL_STEP_KINDS: readonly LegalStepKind[] = [
  "LETTER_OF_DEMAND", "S129_SENT", "SUMMONS_ISSUED", "SUMMONS_SERVED", "JUDGMENT",
  "ATTACHMENT_ORDER", "SHERIFF_RETURN", "ASSET_RECOVERED", "SETTLED", "WITHDRAWN",
]

export interface HintStep {
  id: string
  kind: LegalStepKind
  stepDate: string // YYYY-MM-DD
  correctsStepId: string | null
}

export interface LegalStepHint {
  code: "SEND_S129" | "SEND_DEMAND" | "SUMMONS_FROM" | "SERVE_SUMMONS" | "APPLY_JUDGMENT" | "APPLY_ATTACHMENT" | "RECOVER_ASSET" | "CONTINUE_RECOVERY"
  /** Lower-case sentence fragment; no borrower names or ID numbers. */
  text: string
  /** The date the hint turns on, when it has one (YYYY-MM-DD). */
  date?: string
}

/** Steps that no later step corrects: the ones the database rules count. */
export function effectiveSteps(steps: readonly HintStep[]): HintStep[] {
  const corrected = new Set(steps.flatMap((step) => (step.correctsStepId ? [step.correctsStepId] : [])))
  return steps.filter((step) => !corrected.has(step.id))
}

/**
 * What the matter waits for next, from its effective steps (null once settled
 * or withdrawn). The summons date is the earliest section 129 date plus 10 SA
 * business days (NCA) or the letter of demand's date (NON_NCA), the same
 * dates the database guard admits a summons on.
 * The s129(1)/s130(1)(a) reading is signed off by the lender's legal team, 2026-10-17.
 */
export function nextLegalStepHint(regime: LegalRegime, steps: readonly HintStep[]): LegalStepHint | null {
  const live = effectiveSteps(steps)
  const has = (kind: LegalStepKind) => live.some((step) => step.kind === kind)
  if (has("SETTLED") || has("WITHDRAWN")) return null
  if (has("ASSET_RECOVERED")) return { code: "CONTINUE_RECOVERY", text: "asset recovered: continue in the recovery" }
  if (has("ATTACHMENT_ORDER")) return { code: "RECOVER_ASSET", text: "attach the asset and record it as recovered" }
  if (has("JUDGMENT")) return { code: "APPLY_ATTACHMENT", text: "apply for the attachment order" }
  if (has("SUMMONS_SERVED")) return { code: "APPLY_JUDGMENT", text: "apply for judgment" }
  if (has("SUMMONS_ISSUED")) return { code: "SERVE_SUMMONS", text: "serve the summons" }
  const dates = live.filter((step) => step.kind === (regime === "NCA" ? "S129_SENT" : "LETTER_OF_DEMAND")).map((step) => step.stepDate).sort()
  if (dates.length === 0) {
    return regime === "NCA"
      ? { code: "SEND_S129", text: "send the section 129 notice" }
      : { code: "SEND_DEMAND", text: "send the letter of demand" }
  }
  const date = regime === "NCA" ? addSouthAfricanBusinessDays(dates[0], 10) : dates[0]
  return { code: "SUMMONS_FROM", text: `summons may issue from ${date}`, date }
}
