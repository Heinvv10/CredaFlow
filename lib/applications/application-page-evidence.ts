import { approvalEvidenceRules } from "@/lib/non-nca-documents/regime-evidence"

const BUREAU_PANEL_STATUSES = new Set(["UNDER_REVIEW", "APPROVED", "DECLINED", "DISBURSED"])

/**
 * What the staff application page shows of the South African consumer evidence, by the application's disclosure regime
 * (lib/non-nca-documents/regime-evidence.ts). An NCA_PASQ application sees all of it; a key-facts application is asked
 * for none, so the page must not show a blocker or an action that leads nowhere. Pure.
 */
export function applicationPageEvidence(input: {
  status: string
  disclosureRegime?: string | null
  creditLifeDisclosureOk: boolean
  bureauAction: "retry" | "rerun"
}) {
  const rules = approvalEvidenceRules(input)
  const creditLifeMissing = rules.creditLifeElection && !input.creditLifeDisclosureOk
  return {
    /** The rail blocker on an application under review. */
    creditLifeElectionMissing: input.status === "UNDER_REVIEW" && creditLifeMissing,
    /** A draft cannot be submitted until the election is recaptured. */
    creditLifeBlocksSubmit: input.status === "DRAFT" && creditLifeMissing,
    /** The NCA reckless-lending checks: the rail blocker and the capture panel. */
    ncaChecks: rules.recklessLendingAssessment,
    /** The primary bureau button, on the rail of an application under review. */
    bureauRetry: rules.bureauCheck && input.bureauAction === "retry",
    /** The secondary bureau button. */
    bureauRerun: input.status === "UNDER_REVIEW" && rules.bureauCheck && input.bureauAction === "rerun",
    bureauPanel: rules.bureauCheck && BUREAU_PANEL_STATUSES.has(input.status),
  }
}
