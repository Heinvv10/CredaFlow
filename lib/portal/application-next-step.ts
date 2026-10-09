// Single source of truth for the portal application page's "what happens
// next" guidance. The page previously derived the reassurance banner ("No
// action is required from you right now") and the PASQ acknowledgement card
// ("Action required: review your PASQ") from two independent conditions, and
// both rendered at once on the same screen. One decision, one truth.
export interface PortalNextStepInput {
  status: string
  agreementGeneratedAt: Date | null
  pasqDocumentId: string | null
  pasqDocumentSha256: string | null
  pasqAcknowledgedAt: Date | null
  pasqAcknowledgedSha256: string | null
}

export type PortalNextStep = "pasq_acknowledgement" | "review_wait" | "none"

/**
 * Whether a PASQ is currently in front of the consumer. Also the mount
 * condition for PasqAcknowledgementCard — the card and the banner must
 * derive from the SAME predicate or the two drift back into the original
 * contradiction.
 */
export function portalPasqOnScreen(app: PortalNextStepInput): boolean {
  // NCA s.92(1) attaches the quotation to entering into the agreement, not to
  // the credit decision, so the ceremony window is APPROVED-before-agreement.
  // Once the agreement exists the quotation has been used and is no longer
  // something the consumer is being asked to act on.
  return (
    app.status === "APPROVED"
    && app.agreementGeneratedAt === null
    && app.pasqDocumentId !== null
    && app.pasqDocumentSha256 !== null
  )
}

export function portalPasqAcknowledged(app: PortalNextStepInput): boolean {
  return (
    app.pasqAcknowledgedAt !== null
    && app.pasqAcknowledgedSha256 === app.pasqDocumentSha256
  )
}

export function portalApplicationNextStep(app: PortalNextStepInput): PortalNextStep {
  if (portalPasqOnScreen(app) && !portalPasqAcknowledged(app)) return "pasq_acknowledgement"
  if (app.status === "SUBMITTED" || app.status === "UNDER_REVIEW") return "review_wait"
  return "none"
}
