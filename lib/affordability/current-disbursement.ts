import {
  affordabilityContractCanBeDisbursed,
  affordabilityContractEvidenceIsIntact,
  loanCalculationFromEvidence,
  readAffordabilitySnapshotStore,
  type AffordabilityContractEvidence,
  type AffordabilityDecisionSnapshot,
  type BureauDecisionCheckInput,
} from "@/lib/affordability/snapshot"
import { verifySubmissionAffordabilitySnapshot } from "@/lib/affordability/submission-snapshot"
import {
  verifyCurrentAffordabilityApproval,
  type CurrentApprovalEvidenceApplication,
  type CurrentApprovalEvidenceReason,
} from "@/lib/affordability/current-approval"

/**
 * The whole "is the approved decision still the decision?" question, as one
 * pure function over columns and stored snapshot JSON.
 *
 * Lifted verbatim out of `app/api/applications/[id]/disburse/route.ts`, where
 * it lived as a route-local helper and was therefore unreachable by anything
 * that wanted to ASK the question without answering it — the board's readiness
 * chip being the first such caller. The disburse route still calls it twice,
 * once as a pre-transaction fail-fast and once under locks at the payout
 * instant; a second copy of these rules beside it is exactly the drift this
 * module exists to prevent.
 *
 * Nothing here reads bytes. Every leg is a column, a stored digest, or the
 * affordability snapshot store — which is why a caller that must not touch
 * disk can still run all of it.
 */
export type CurrentDisbursementEvidenceApplication =
  CurrentApprovalEvidenceApplication & {
    client: { kycStatus: string }
    pasqAcknowledgedAt: Date | null
    pasqAcknowledgedBy: string | null
    clientAffordabilityDeclaredAt: Date | null
    recklessLendingAssessed: boolean
    recklessLendingAssessedAt: Date | null
    recklessLendingAssessedById: string | null
    agreementGeneratedAt: Date | null
    approvedPasqDocumentSha256: string | null
    repaymentMethod: "EFT" | "DEBIT_ORDER" | null
  }

export type CurrentDisbursementEvidenceReason =
  | CurrentApprovalEvidenceReason
  | "kyc_changed"
  | "submission_missing"
  | "submission_changed"
  | "compliance_missing"
  | "contract_missing"
  | "contract_changed"
  | "contract_expired"

export type CurrentDisbursementEvidenceResult =
  | {
      ok: true
      approval: AffordabilityDecisionSnapshot
      contract: AffordabilityContractEvidence
      calculation: ReturnType<typeof loanCalculationFromEvidence>
      contractStartDate: Date
    }
  | { ok: false; reason: CurrentDisbursementEvidenceReason }

export function verifyCurrentDisbursementEvidence(args: {
  application: CurrentDisbursementEvidenceApplication
  bureauCheck: BureauDecisionCheckInput | null
  tenantConfig: {
    ndiBufferPct: number
    bureauMinScore: number
    bureauBlockAdverse: boolean
  } | null
  // The instant the contract is being judged at. The pre-transaction call
  // passes its own clock reading as a fail-fast; the authoritative call inside
  // the transaction passes the payout instant, so the contract is tested
  // against the moment money actually moves.
  at: Date
}): CurrentDisbursementEvidenceResult {
  const { application, bureauCheck, tenantConfig, at } = args
  if (application.client.kycStatus !== "VERIFIED") {
    return { ok: false as const, reason: "kyc_changed" as const }
  }
  const affordabilityStore = readAffordabilitySnapshotStore(application.affordabilityResult)
  const submission = verifySubmissionAffordabilitySnapshot(application)
  if (!submission.ok) return { ok: false as const, reason: submission.reason }
  const storedApproval = affordabilityStore.approval
  if (
    storedApproval &&
    (!application.pasqAcknowledgedAt ||
      !application.pasqAcknowledgedBy ||
      !application.clientAffordabilityDeclaredAt ||
      !application.recklessLendingAssessed ||
      !application.recklessLendingAssessedAt ||
      !application.recklessLendingAssessedById)
  ) {
    return { ok: false as const, reason: "compliance_missing" as const }
  }
  const currentApproval = verifyCurrentAffordabilityApproval({
    application,
    bureauCheck,
    tenantConfig,
  })
  if (!currentApproval.ok) return currentApproval
  const contract = affordabilityStore.contract
  if (!contract) {
    return { ok: false as const, reason: "contract_missing" as const }
  }
  if (
    !affordabilityContractEvidenceIsIntact(contract, currentApproval.approval) ||
    !application.agreementGeneratedAt ||
    contract.establishedAt !== application.agreementGeneratedAt.toISOString() ||
    contract.acceptedPasqDocumentSha256 !== application.approvedPasqDocumentSha256
  ) {
    return { ok: false as const, reason: "contract_changed" as const }
  }
  // Null reads as DEBIT_ORDER here exactly as it does in the disburse route: an
  // unknown collection method takes the strict same-day path.
  if (!affordabilityContractCanBeDisbursed(contract, at, application.repaymentMethod)) {
    return { ok: false as const, reason: "contract_expired" as const }
  }
  return {
    ok: true as const,
    approval: currentApproval.approval,
    contract,
    calculation: loanCalculationFromEvidence(contract.calculator),
    contractStartDate: new Date(contract.calculator.startDate),
  }
}
