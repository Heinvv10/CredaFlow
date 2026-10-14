import { DOC_TYPE_LABELS } from "@/lib/document-types"
import { deriveKycBlockers, kycGateStage } from "@/lib/kyc/kyc-blockers"
import type { CompositeKycResult, CoreDocumentGap } from "@/lib/kyc/document-state"
import { verifySubmissionAffordabilitySnapshot } from "@/lib/affordability/submission-snapshot"
import {
  verifyCurrentDisbursementEvidence,
  type CurrentDisbursementEvidenceApplication,
} from "@/lib/affordability/current-disbursement"
import type { BureauDecisionCheckInput } from "@/lib/affordability/snapshot"
import {
  verifyAppliedCreditLifeDisclosure,
  verifyStoredCreditLifeDisclosure,
  type StoredCreditLifeDisclosure,
} from "@/lib/insurance/credit-life-election.server"
import { evaluateBureauGate, nonOverridableBlock } from "@/lib/decision/bureau-gate"
import { simulatedBureauBlock } from "@/lib/decision/bureau-simulated"
import {
  verifyStoredProviderCountersign,
  type StoredProviderCountersign,
} from "@/lib/compliance/provider-countersign"
import {
  debitMandateSignatureLegs,
  type StoredSignedDebitMandate,
} from "@/lib/compliance/debit-mandate"
import { currentVerifiedBankDetails } from "@/lib/compliance/debit-mandate.server"
import type { DebitMandateApplication } from "@/lib/compliance/debit-mandate.server"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import { PAYOUT_BLOCK_LABELS } from "@/lib/applications/pipeline-view"
import {
  DISBURSEMENT_PRECONDITION_ORDER,
  type DisbursementPrecondition,
} from "@/lib/disbursement/preconditions"
import type { ApplicationReadiness } from "@/lib/applications/readiness-view"

/**
 * What still stands between an application and its NEXT transition, summarised
 * for one board card.
 *
 * SCOPE. Every gate that is decidable WITHOUT opening a file is evaluated,
 * including all eight of `DISBURSEMENT_PRECONDITION_ORDER`. An earlier cut of
 * this covered five and justified the gap as "byte-level"; that was wrong.
 * PASQ acknowledgement is a pair of null columns, and the affordability and
 * credit-life legs are reads of snapshot JSON already on the row. A card could
 * therefore read "Ready to disburse" over an application with no PASQ
 * acknowledgement — an NCA gate — which is why the leg set is now tied to the
 * precondition list with `satisfies`.
 *
 * What is still NOT evaluated is exactly four things, all of which mean
 * reading stored bytes or a second document row:
 *   1. the signed agreement bytes hashing to `agreementDocumentSha256`
 *   2. the signed debit-mandate bytes hashing to their stored digest
 *   3. the acknowledged PASQ PDF bytes (`verifyPasqDocumentArtifact`)
 *   4. the verified bank STATEMENT matching the payout tuple
 *      (`findVerifiedBankStatementForMandate` re-reads and re-extracts a PDF)
 * `payoutBlock` in pipeline-view.ts documents why that class of work does not
 * belong on a per-card render, and this respects that line.
 *
 * So READY means "every blocker short of a byte check is clear", NOT "the API
 * will say yes" — those four can still refuse a READY card, and the chip says
 * so on its own tooltip rather than only in this comment. The routes remain
 * the only authority. Every blocker it DOES report comes from the same helper
 * the enforcing route calls, so a MISSING chip never invents a rule.
 *
 * SERVER ONLY. Several of those helpers reach `lib/storage` and therefore
 * `node:fs/promises`. The card's copy and the readiness type live in
 * `readiness-view.ts` so a client component can import them without dragging
 * this graph into the browser bundle.
 */
export type { ApplicationReadiness, ReadinessStage } from "@/lib/applications/readiness-view"

/** The bureau markers `evaluateBureauGate` scores, as the board loads them. */
export interface ReadinessBureauCheck {
  score: number | null
  unscoreable: boolean
  hasAdverse: boolean
  deceased: boolean
  underDebtReview: boolean
  hasJudgement: boolean
  hasNotice: boolean
  /** Carries the `simulated` marker the bureau gate reads. */
  obligations?: unknown
}

/** The client columns the payout bank tuple is built from. */
export interface ReadinessClient {
  bankName: string | null
  bankBranchCode: string | null
  bankAccountNumber: string | null
  accountType: string | null
}

export interface ReadinessApplication {
  status: string
  submittedAt: Date | null
  appliedAmount: number
  appliedTermDays: number
  affordabilityResult: unknown
  clientAffordabilityDeclaredAt: Date | null
  recklessLendingAssessed: boolean
  recklessLendingAssessedAt: Date | null
  recklessLendingAssessedById: string | null
  repaymentMethod: string | null
  agreementSignedAt: Date | null
  agreementDocumentId: string | null
  agreementDocumentSha256: string | null
  creditLife: StoredCreditLifeDisclosure
  countersign: StoredProviderCountersign
  mandate: StoredSignedDebitMandate
  client: ReadinessClient
  /**
   * The same row, in the shape the payout evidence check wants. Carried as its
   * own field rather than widening this interface, so the shape stays owned by
   * `current-disbursement.ts` — when that check starts needing another column,
   * the board fails to compile until it selects it.
   */
  disbursementEvidence: CurrentDisbursementEvidenceApplication
}

export interface ReadinessInput {
  application: ReadinessApplication
  /** Composite KYC for this client, or null when the status has no KYC gate. */
  kyc: CompositeKycResult | null
  /** Unresolved non-biometric document mismatches on the client. */
  documentMismatchCount: number
  /** The current, non-stale, provider-correct bureau check, or null. */
  bureau: ReadinessBureauCheck | null
  bureauPolicy: { bureauMinScore: number; bureauBlockAdverse: boolean }
  /** The same check in the shape the payout evidence path wants, or null. */
  bureauEvidenceCheck: BureauDecisionCheckInput | null
  tenantConfig: {
    ndiBufferPct: number
    bureauMinScore: number
    bureauBlockAdverse: boolean
  } | null
  /**
   * One clock for the whole board. The contract-expiry leg is time-dependent,
   * and two cards in the same paint must not disagree about whether a quote is
   * still binding.
   */
  now: Date
}

/**
 * What has to happen to each outstanding core document.
 *
 * `deriveKycBlockers` rolls all of them into one "N KYC documents outstanding"
 * blocker, which is right for a rail that also prints the detail line. A card
 * has room for two words per blocker and no detail line, so the document NAME
 * is the useful half. Derived from the same `coreDocumentGaps` that blocker's
 * detail is built from, so the two cannot disagree about which documents or
 * which state.
 */
const GAP_SUFFIX: Record<CoreDocumentGap["state"], string> = {
  not_uploaded: "missing",
  awaiting_verification: "unverified",
  flagged: "flagged",
  rejected: "rejected",
}

function documentGapLabels(gaps: readonly CoreDocumentGap[]): string[] {
  return gaps.map(
    (gap) =>
      `${DOC_TYPE_LABELS[gap.docType] ?? gap.docType} ${GAP_SUFFIX[gap.state]}`,
  )
}

function kycBlockerLabels(
  kyc: CompositeKycResult | null,
  status: string,
): string[] {
  const stage = kycGateStage(status)
  if (!stage) return []
  return deriveKycBlockers(kyc, stage).flatMap((blocker) =>
    blocker.kind === "missing_documents"
      ? documentGapLabels(kyc?.coreDocumentGaps ?? [])
      : [blocker.label],
  )
}

/** What blocks a decision on a SUBMITTED application — see review/route.ts. */
function reviewBlockers(input: ReadinessInput): string[] {
  const blockers = kycBlockerLabels(input.kyc, input.application.status)
  // The review route refuses on unresolved mismatches BEFORE it reads the
  // composite gate, but it reports them together on the detail rail, so both
  // are listed. Approval does not enforce this, which is why it is here only.
  if (input.documentMismatchCount > 0) {
    blockers.push(
      `${input.documentMismatchCount} document mismatch${
        input.documentMismatchCount === 1 ? "" : "es"
      }`,
    )
  }
  return blockers
}

/** What blocks approval of an UNDER_REVIEW application — see decide/route.ts. */
function approvalBlockers(input: ReadinessInput): string[] {
  const { application } = input
  const blockers: string[] = []

  const submission = verifySubmissionAffordabilitySnapshot(application)
  if (!submission.ok) {
    blockers.push(
      submission.reason === "submission_missing"
        ? "Affordability evidence missing"
        : "Affordability evidence altered",
    )
  }

  blockers.push(...kycBlockerLabels(input.kyc, application.status))

  // The APPLIED-for terms, which is what /decide checks before approval. The
  // payout path deliberately uses the APPROVED terms instead; the two are not
  // interchangeable, and the helper name is what keeps them straight.
  const creditLife = verifyAppliedCreditLifeDisclosure({
    ...application.creditLife,
    appliedAmount: application.appliedAmount,
    appliedTermDays: application.appliedTermDays,
  })
  if (!creditLife.ok) blockers.push("Credit-life election missing")

  if (!application.clientAffordabilityDeclaredAt) {
    blockers.push("Affordability declaration missing")
  }
  if (
    !application.recklessLendingAssessed
    || !application.recklessLendingAssessedAt
    || !application.recklessLendingAssessedById
  ) {
    blockers.push("Reckless-lending assessment missing")
  }

  // Deceased is checked before everything bureau-related and cannot be
  // overridden, so it is reported alone: no other blocker on the card is worth
  // an operator's time once this one is true.
  if (nonOverridableBlock({ deceased: input.bureau?.deceased ?? false }).blocked) {
    return ["Bureau reports deceased"]
  }
  // Not overridable: a reasoned override cannot approve on fabricated evidence.
  if (simulatedBureauBlock(input.bureau?.obligations).blocked) {
    return ["Bureau check is simulated"]
  }
  if (!input.bureau) {
    // A reasoned override can still approve without one, which is why this
    // reads as a requirement rather than a refusal.
    blockers.push("Bureau check required")
  } else if (evaluateBureauGate(input.bureau, input.bureauPolicy).blocked) {
    blockers.push("Bureau risk gate")
  }

  return blockers
}

/**
 * What blocks payout of an APPROVED application.
 *
 * Keyed by `DISBURSEMENT_PRECONDITION_ORDER` and tied to it with `satisfies`,
 * so a ninth precondition breaks the build here rather than silently going
 * unreported — the same tie `PAYOUT_BLOCK_LABELS` already carries, and for the
 * same reason. The first cut of this covered five of the eight and could draw
 * "Ready to disburse" over an application with no PASQ acknowledgement at all,
 * which is an NCA gate.
 *
 * `null` means the leg is satisfied. An array is a leg with several distinct
 * blockers (composite KYC names each outstanding document).
 */
function payoutBlockers(input: ReadinessInput): string[] {
  const { application } = input

  const agreementBound = Boolean(
    application.agreementSignedAt
    && application.agreementDocumentId
    && isSha256Digest(application.agreementDocumentSha256),
  )
  const countersigned =
    agreementBound && verifyStoredProviderCountersign(application.countersign).ok

  // The whole approval-still-holds question, run through the exact function
  // the disburse route runs — not a summary of it. Every leg is a column or a
  // stored snapshot; nothing here opens a file.
  const evidence = verifyCurrentDisbursementEvidence({
    application: application.disbursementEvidence,
    bureauCheck: input.bureauEvidenceCheck,
    tenantConfig: input.tenantConfig,
    at: input.now,
  })
  // `verifyCurrentDisbursementEvidence` folds the PASQ legs into its own
  // reason set, so the reason decides which precondition owns the failure.
  // Reporting a missing acknowledgement as "affordability changed" would send
  // staff to reassess a decision that is fine.
  const pasqReason =
    !evidence.ok
    && (evidence.reason === "pasq_changed" || evidence.reason === "compliance_missing")
  const pasqAcknowledged = Boolean(
    application.disbursementEvidence.pasqAcknowledgedAt
    && application.disbursementEvidence.pasqAcknowledgedBy,
  )

  // The disclosure is checked against the APPROVED terms, not the applied-for
  // ones: by payout the consumer is bound to what was approved. Using the
  // applied figures here would pass a disclosure the route refuses.
  const creditLifeOk = evidence.ok
    ? verifyStoredCreditLifeDisclosure(application.creditLife, {
        principalCents: evidence.approval.inputs.principalCents,
        termDays: evidence.approval.inputs.termDays,
      }).ok
    : false

  const bankDetails = currentVerifiedBankDetails({
    client: application.client,
  } as unknown as DebitMandateApplication)
  // Null is a debit order, fail-closed, exactly as the disburse route reads it.
  const mandateRequired = (application.repaymentMethod ?? "DEBIT_ORDER") === "DEBIT_ORDER"

  const verdicts = {
    acknowledged_pasq:
      !pasqAcknowledged || pasqReason ? "PASQ not acknowledged" : null,
    signed_agreement: agreementBound ? null : PAYOUT_BLOCK_LABELS.signed_agreement,
    // Only once there is a signed agreement to countersign. Reported before
    // that, it would tell staff to chase a signature that cannot yet exist.
    provider_countersign:
      agreementBound && !countersigned ? PAYOUT_BLOCK_LABELS.provider_countersign : null,
    composite_kyc: kycBlockerLabels(input.kyc, application.status),
    unchanged_affordability:
      evidence.ok || pasqReason
        ? null
        : evidence.reason === "bureau_simulated"
          ? "Bureau check is simulated"
          : PAYOUT_BLOCK_LABELS.unchanged_affordability,
    verified_banking: bankDetails ? null : PAYOUT_BLOCK_LABELS.verified_banking,
    signed_debit_mandate: !mandateRequired
      ? null
      : bankDetails?.accountType === "OTHER"
        // The Netcash AVS wire has no value to send for OTHER, so no mandate
        // can ever be prepared for this account — /decide refuses the pairing
        // at approval for the same reason.
        ? "Account type not debit-orderable"
        // The signature legs only. The full `verifyStoredSignedDebitMandate`
        // re-derives the expected evidence from the contract terms and the
        // verified bank statement, which is a per-card cost the board will not
        // pay — so this is a NECESSARY condition: "not signed" is
        // authoritative, silence still leaves the evidence legs unchecked.
        : debitMandateSignatureLegs(application.mandate).ok
          ? null
          : PAYOUT_BLOCK_LABELS.signed_debit_mandate,
    insurance_election: creditLifeOk ? null : PAYOUT_BLOCK_LABELS.insurance_election,
  } satisfies Record<DisbursementPrecondition, string | string[] | null>

  // Reported in the order the route refuses them, so the first blocker on the
  // card is the first one a payout attempt would hit.
  return DISBURSEMENT_PRECONDITION_ORDER.flatMap((precondition) => {
    const verdict = verdicts[precondition]
    return verdict === null ? [] : typeof verdict === "string" ? [verdict] : verdict
  })
}

/**
 * The readiness of one application, or null where the board draws no chip.
 *
 * DRAFT has no gate ahead of it that the consumer has finished feeding, and
 * DISBURSED has none left; a chip on either would be noise on a lane nobody
 * triages. Terminal statuses are the same.
 */
export function computeReadiness(app: ReadinessInput): ApplicationReadiness | null {
  const blockers = (() => {
    switch (app.application.status) {
      case "SUBMITTED":
        return reviewBlockers(app)
      case "UNDER_REVIEW":
        return approvalBlockers(app)
      case "APPROVED":
        return payoutBlockers(app)
      default:
        return null
    }
  })()
  if (blockers === null) return null
  return { stage: blockers.length === 0 ? "READY" : "MISSING", blockers }
}
