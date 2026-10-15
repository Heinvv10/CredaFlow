import { isCollectionsStageAtOrAfter } from "@/lib/collections/stages"
import { effectiveSteps, type HintStep, type LegalRegime } from "./legal-matter-hint"

export const NCA_ATTORNEY_NEEDS_S129 = "An NCA attorney referral needs a completed section 129 notice first"

/**
 * Why an attorney cannot be appointed yet, or null. An NCA loan needs both
 * what the manual referral route (app/api/loans/[id]/attorney-referral)
 * needs, the loan at or past SECTION_129_SENT with an issued, completed
 * notice record, and an effective S129_SENT step on this matter. NON_NCA has
 * no section 129 gate.
 * UNTESTED: legal sign-off.
 */
export function attorneyAppointmentRefusal(a: {
  regime: LegalRegime
  collectionsStage: string | null
  hasIssuedNotice: boolean
  steps: readonly HintStep[]
}): string | null {
  if (a.regime !== "NCA") return null
  const ready = a.collectionsStage !== null && isCollectionsStageAtOrAfter(a.collectionsStage, "SECTION_129_SENT") && a.hasIssuedNotice
    && effectiveSteps(a.steps).some((step) => step.kind === "S129_SENT")
  return ready ? null : NCA_ATTORNEY_NEEDS_S129
}
