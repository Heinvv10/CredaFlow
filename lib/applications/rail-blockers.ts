/**
 * Approval gates the application page's decision rail lists as blockers.
 *
 * The rail is the one list: the header badge counts it (headerBlockerLabel),
 * so the header cannot say "No blockers" while the rail, or /decide, holds
 * approval. These are the /decide refusals the page can see without the
 * route's recompute; the route stays the authority.
 */
export type RailBlocker = {
  label: string
  detail?: string
  tone?: "neutral" | "success" | "warning" | "danger" | "info"
}

export interface ApprovalGateFacts {
  status: string
  /** affordabilityNDI is recorded; before that the "Affordability pending" blocker stands. */
  affordabilityCaptured: boolean
  /** The Affordability panel's own verdict (lib/affordability/preview.ts). */
  affordable: boolean
  recklessLendingAssessed: boolean
  clientAffordabilityDeclared: boolean
  openCreditChecks: number
}

export function approvalGateBlockers(f: ApprovalGateFacts): RailBlocker[] {
  if (f.status !== "UNDER_REVIEW") return []
  const blockers: RailBlocker[] = []
  if (f.affordabilityCaptured && !f.affordable) {
    blockers.push({
      label: "Not affordable",
      detail: "Approval is refused while the assessment shows the loan is not affordable. Correct the figures or decline.",
      tone: "danger",
    })
  }
  if (!f.recklessLendingAssessed || !f.clientAffordabilityDeclared) {
    blockers.push({
      label: "NCA checks not confirmed",
      detail: "Confirm the reckless-lending assessment and the client's affordability declaration under NCA checks.",
      tone: "warning",
    })
  }
  if (f.openCreditChecks > 0) {
    blockers.push({
      label: `${f.openCreditChecks} open credit check${f.openCreditChecks === 1 ? "" : "s"}`,
      detail: "Clear or resolve them under Credit checks before approval.",
      tone: "warning",
    })
  }
  return blockers
}

export function headerBlockerLabel(blockers: readonly RailBlocker[]): string {
  if (blockers.length === 0) return "No blockers"
  return `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`
}
