import type { CompositeKycResult, CoreDocumentGap } from "@/lib/kyc/document-state"
import { DOC_TYPE_LABELS } from "@/lib/document-types"

/**
 * The composite KYC gate is enforced at three separate transitions, each by a
 * different route, each re-deriving the state fresh:
 *   SUBMITTED    -> review        (app/api/applications/[id]/review/route.ts)
 *   UNDER_REVIEW -> approval      (app/api/applications/[id]/decide/route.ts)
 *   APPROVED     -> disbursement  (app/api/applications/[id]/disburse/route.ts)
 *
 * Nothing pins KYC at approval time — manual rejection is toggled by client,
 * document, selfie and kyc-exception routes independent of application status —
 * so an APPROVED application can regress and must still be evaluated.
 */
export type KycGateStage = "review" | "approval" | "disbursement"

export function kycGateStage(applicationStatus: string): KycGateStage | null {
  switch (applicationStatus) {
    case "SUBMITTED": return "review"
    case "UNDER_REVIEW": return "approval"
    case "APPROVED": return "disbursement"
    default: return null
  }
}

export type KycBlocker = {
  kind: "manual_rejection" | "missing_documents" | "biometric_evidence"
  label: string
  detail: string
  tone: "danger"
}

/**
 * Restate CompositeKycResult as the blockers a staff user can act on.
 *
 * Invariant: returns at least one blocker exactly when the gate for THIS stage
 * is closed — `okForOrigination` at review and approval, the strict `ok` from
 * the signing/payout stage onward. A shorter list would let the rail print
 * "No blockers" over a transition the API will refuse; a longer one would
 * invent a blocker that isn't enforced.
 *
 * Manual rejection is returned alone because that is the order the routes
 * enforce: review/route.ts returns on manual rejection before it ever reads
 * biometric state. Listing a stale biometric failure alongside it would tell
 * the user to re-capture a selfie, which cannot clear a manual rejection.
 */
const GAP_LEAD: Record<CoreDocumentGap["state"], string> = {
  not_uploaded: "Not uploaded",
  awaiting_verification: "Awaiting verification",
  flagged: "Flagged, read the note",
  rejected: "Rejected, needs re-upload",
}

/** Groups the outstanding documents by what has to happen to each. */
export function summariseGaps(gaps: readonly CoreDocumentGap[]): string {
  const order: CoreDocumentGap["state"][] = ["not_uploaded", "rejected", "flagged", "awaiting_verification"]
  return order
    .map((state) => {
      const names = gaps
        .filter((gap) => gap.state === state)
        .map((gap) => DOC_TYPE_LABELS[gap.docType])
      return names.length > 0 ? `${GAP_LEAD[state]}: ${names.join(", ")}.` : null
    })
    .filter((part): part is string => part !== null)
    .join(" ")
}

export function deriveKycBlockers(
  gate: CompositeKycResult | null,
  stage: KycGateStage,
): KycBlocker[] {
  // Origination stages no longer require biometrics (by policy), so
  // "blocked" means something different before and after the signing gate.
  // Reporting the strict result at review would print a danger blocker over a
  // transition the API allows — the false-statement failure this file exists
  // to prevent.
  const strict = stage === "disbursement"
  if (!gate || (strict ? gate.ok : gate.okForOrigination)) return []

  if (gate.manualRejectionActive) {
    return [{
      kind: "manual_rejection",
      label: "KYC manually rejected",
      detail: `An authorised KYC decision must resolve the rejection before ${stage} can proceed. Re-capturing documents will not clear it.`,
      tone: "danger",
    }]
  }

  const blockers: KycBlocker[] = []
  if (gate.missingCoreDocuments.length > 0) {
    const count = gate.missingCoreDocuments.length
    blockers.push({
      kind: "missing_documents",
      label: `${count} KYC document${count === 1 ? "" : "s"} outstanding`,
      // "Missing" described only one of three states and sent staff hunting
      // for an upload that was already on file. Each needs a different action:
      // chase the client, review it, or tell the client it was refused.
      detail: `KYC must be completed and verified before ${stage} can proceed. ${summariseGaps(gate.coreDocumentGaps)}`,
      tone: "danger",
    })
  }
  // Before signing, only a capture that FAILED blocks; one never taken does
  // not. From the signing gate onward, absent evidence blocks too.
  const biometricBlocks = gate.biometricEvidence && !gate.manualExceptionActive &&
    (strict || gate.biometricAttemptFailed)
  if (biometricBlocks) {
    // Two different worlds. A capture that failed can be re-taken; one that
    // never happened has nothing to re-take, and its honest remedy includes
    // the in-person route. Relaxing origination made the second state
    // reachable here, which turned the old wording from terse into false.
    // A selfie bound to an ID copy that is not the newest verified one was
    // captured: "no selfie has been captured" would be false for it.
    blockers.push(gate.biometricAttemptFailed || gate.biometricIdDocumentNotCurrent
      ? {
          kind: "biometric_evidence",
          label: "Biometric evidence invalid",
          detail: `The latest selfie does not establish current valid biometric evidence. Re-capture it before ${stage} can proceed.`,
          tone: "danger",
        }
      : {
          kind: "biometric_evidence",
          label: "Identity not yet verified",
          detail: `No selfie has been captured. Capture one, or record an in-person verification, before ${stage} can proceed.`,
          tone: "danger",
        })
  }
  return blockers
}
