/**
 * Builders for the consumer decision events (the allow-list). Each takes the
 * named facts the route already holds and copies only those into the record:
 * no row is ever spread in, so a field added to a model later cannot leak
 * into the log. Identifiers, names, contacts, bank details and bureau
 * payloads never reach the snapshot; amounts reach it only as bands.
 */
import { APPROVAL_AFFORDABILITY_POLICY_VERSION } from "@/lib/affordability/snapshot"
import { bureauBlockCode, type BureauFacts } from "./bureau-code"
import {
  DECISION_LOG_VERSION,
  amountBand,
  bureauScoreBand,
  incomeBand,
  instalmentBand,
  ndiCoverBand,
  type DecisionRecordInput,
} from "./decision-log"

export interface DecisionThresholds {
  bureauMinScore: number
  bureauBlockAdverse: boolean
  ndiBufferPct: number
  bureauMaxAgeDays: number
}

export interface StaffActor {
  userId: string
  role: string | null
}

/** The rules engine acting alone (lib/decisioning/): recorded as a SYSTEM decision, never as a staff one. */
export interface SystemActor {
  system: true
}

/** What the rules engine decided on, kept in the record next to the gates' verdicts. */
export interface AutomationFacts {
  ruleVersion: string
  reasonCodes: readonly string[]
  riskGrade: string | null
}

/** The credit-check rules carry no version id of their own yet (DESIGN.md, "Rule versions"). */
export const CREDIT_CHECK_POLICY_VERSION = "credit-checks-unversioned"

interface ApplicationSubject {
  tenantId: string
  applicationId: string
  /** Null for a business-entity borrower, or where the caller does not hold it (the application id is the subject). */
  clientId: string | null
  actor: StaffActor | SystemActor
  decidedAt: Date
}

export interface ConsumerApprovalFacts extends ApplicationSubject {
  productType: string
  interestRatePm: number
  principalCents: number
  termDays: number
  instalmentCents: number
  creditLifePremiumCents: number
  repaymentMethod: string
  monthlyIncomeCents: number
  thresholds: DecisionThresholds
  bureau: (BureauFacts & { id: string; provider: string }) | null
  /** The bureau gate's verdict as the route evaluated it; null when there was no check. */
  bureauGateBlocked: boolean | null
  bureauOverrideReason: string | null
  affordability: { ndiCents: number; requiredNdiCents: number }
  screeningState: string
  creditCheckFlags: readonly { id: string; check: string; code: string; status: string }[]
  affordabilitySnapshot: { policyVersion: string; inputFingerprint: string; decisionFingerprint: string }
  /** Set when the rules engine approved (lib/decisioning/): the actor is then a SystemActor. */
  automation?: AutomationFacts
}

const staff = (actor: StaffActor | SystemActor) =>
  "system" in actor ? { type: "SYSTEM" as const } : { type: "STAFF" as const, userId: actor.userId, role: actor.role }

export const thresholdPolicy = (t: DecisionThresholds) => ({
  bureauMinScore: t.bureauMinScore,
  bureauBlockAdverse: t.bureauBlockAdverse,
  ndiBufferPct: t.ndiBufferPct,
  bureauMaxAgeDays: t.bureauMaxAgeDays,
})

const subjectOf = (f: ApplicationSubject) => ({ applicationId: f.applicationId, clientId: f.clientId })
const applicationSource = (f: ApplicationSubject) => ({ entityType: "LoanApplication", entityId: f.applicationId })

/**
 * The approval and the offer it makes (the approved terms). The gates that
 * block an approval outright (affordability, open checks, screening, KYC,
 * deceased) cannot be overridden, so an approval reached them all passing;
 * the bureau gate alone can be overridden with a reason.
 */
export function consumerApprovalRecords(f: ConsumerApprovalFacts): DecisionRecordInput[] {
  const bureauMissing = f.bureau === null
  const blockCode = bureauMissing
    ? "BUREAU_MISSING"
    : f.bureauGateBlocked
      ? (bureauBlockCode(f.bureau!, f.thresholds) ?? "OTHER")
      : null
  const overridden = blockCode !== null
  const cleared = f.creditCheckFlags.filter((flag) => flag.status === "CLEARED")
  const policy = thresholdPolicy(f.thresholds)
  const ruleVersion = `${DECISION_LOG_VERSION}+${f.affordabilitySnapshot.policyVersion}${f.automation ? `+${f.automation.ruleVersion}` : ""}`
  const evidenceRefs = {
    bureauCheckId: f.bureau?.id ?? null,
    affordabilityPolicyVersion: f.affordabilitySnapshot.policyVersion,
    affordabilityInputFingerprint: f.affordabilitySnapshot.inputFingerprint,
    affordabilityDecisionFingerprint: f.affordabilitySnapshot.decisionFingerprint,
    creditCheckFlagIds: f.creditCheckFlags.map((flag) => flag.id).sort(),
  }
  const exactInputs = {
    productType: f.productType,
    interestRatePm: f.interestRatePm,
    principalCents: f.principalCents,
    termDays: f.termDays,
    instalmentCents: f.instalmentCents,
    creditLifePremiumCents: f.creditLifePremiumCents,
    repaymentMethod: f.repaymentMethod,
    monthlyIncomeCents: f.monthlyIncomeCents,
    ndiCents: f.affordability.ndiCents,
    requiredNdiCents: f.affordability.requiredNdiCents,
    bureauScore: f.bureau?.score ?? null,
    bureauBlockCode: blockCode,
    screeningState: f.screeningState,
    creditCheckFlags: f.creditCheckFlags.map((flag) => `${flag.id}:${flag.check}:${flag.code}:${flag.status}`).sort(),
  }
  const decision: DecisionRecordInput = {
    tenantId: f.tenantId,
    kind: "CREDIT_DECISION",
    decision: "APPROVE",
    recommendation: overridden ? "BLOCK" : "PASS",
    overrideReason: overridden ? f.bureauOverrideReason : null,
    actor: staff(f.actor),
    subject: subjectOf(f),
    source: applicationSource(f),
    ruleVersion,
    policy,
    snapshot: {
      productType: f.productType,
      amountBand: amountBand(f.principalCents),
      termDays: f.termDays,
      incomeBand: incomeBand(f.monthlyIncomeCents),
      bureau: {
        gate: bureauMissing ? "MISSING" : f.bureauGateBlocked ? "BLOCK" : "PASS",
        blockCode,
        scoreBand: bureauScoreBand(f.bureau?.score ?? null),
        provider: f.bureau?.provider ?? null,
        overridden,
        // The application row stores a reason given past a passing gate as an
        // override; the log says it was not needed rather than hide it.
        reasonGivenUnneeded: !overridden && f.bureauOverrideReason !== null,
      },
      affordability: {
        gate: "PASS",
        ndiCoverBand: ndiCoverBand(f.affordability.ndiCents, f.affordability.requiredNdiCents),
      },
      creditChecks: { cleared: cleared.length, clearedCodes: cleared.map((flag) => `${flag.check}:${flag.code}`).sort() },
      screening: f.screeningState,
      thresholds: policy,
      ...(f.automation ? { automated: { ruleVersion: f.automation.ruleVersion, reasonCodes: [...f.automation.reasonCodes], riskGrade: f.automation.riskGrade } } : {}),
    },
    evidenceRefs,
    exactInputs,
    decidedAt: f.decidedAt,
  }
  const offer: DecisionRecordInput = {
    ...decision,
    kind: "OFFER",
    decision: "APPROVED_TERMS",
    recommendation: "NONE",
    overrideReason: null,
    snapshot: {
      productType: f.productType,
      amountBand: amountBand(f.principalCents),
      termDays: f.termDays,
      interestRatePm: f.interestRatePm,
      instalmentBand: instalmentBand(f.instalmentCents),
      creditLife: f.creditLifePremiumCents > 0,
      repaymentMethod: f.repaymentMethod,
    },
  }
  return [decision, offer]
}

export function consumerDeclineRecord(f: ApplicationSubject & { declineCategory: string }): DecisionRecordInput {
  return {
    tenantId: f.tenantId,
    kind: "CREDIT_DECISION",
    decision: "DECLINE",
    // The decline path evaluates no gate (docs/learning-loop/DESIGN.md, deferred).
    recommendation: "NONE",
    overrideReason: null,
    actor: staff(f.actor),
    subject: subjectOf(f),
    source: applicationSource(f),
    ruleVersion: `${DECISION_LOG_VERSION}+${APPROVAL_AFFORDABILITY_POLICY_VERSION}`,
    policy: {},
    snapshot: { declineCategory: f.declineCategory },
    evidenceRefs: {},
    exactInputs: { declineCategory: f.declineCategory },
    decidedAt: f.decidedAt,
  }
}

/** A return to review (undoes an approval) or to draft (undoes a submission). */
export function consumerReturnRecord(f: ApplicationSubject & { to: "REVIEW" | "DRAFT"; priorStatus: string }): DecisionRecordInput {
  return {
    tenantId: f.tenantId,
    kind: "CREDIT_DECISION",
    decision: f.to === "REVIEW" ? "RETURN_TO_REVIEW" : "RETURN_TO_DRAFT",
    recommendation: "NONE",
    overrideReason: null,
    actor: staff(f.actor),
    subject: subjectOf(f),
    source: applicationSource(f),
    ruleVersion: DECISION_LOG_VERSION,
    policy: {},
    snapshot: { priorStatus: f.priorStatus },
    evidenceRefs: {},
    exactInputs: { priorStatus: f.priorStatus },
    decidedAt: f.decidedAt,
  }
}

/** A credit check referred the application; a person cleared the flag with a reason. */
export function creditCheckClearRecord(f: ApplicationSubject & {
  flagId: string
  check: string
  code: string
  reason: string
  policyVersion: string
}): DecisionRecordInput {
  return {
    tenantId: f.tenantId,
    kind: "CREDIT_DECISION",
    decision: "CLEAR_FLAG",
    recommendation: "REFER",
    overrideReason: f.reason,
    actor: staff(f.actor),
    subject: subjectOf(f),
    source: { entityType: "ApplicationCheckFlag", entityId: f.flagId },
    ruleVersion: `${DECISION_LOG_VERSION}+${f.policyVersion}`,
    policy: { creditCheckPolicy: f.policyVersion },
    snapshot: { check: f.check, code: f.code },
    evidenceRefs: { creditCheckFlagId: f.flagId },
    exactInputs: { check: f.check, code: f.code },
    decidedAt: f.decidedAt,
  }
}

/** The PASQ (Form 20 pre-agreement quotation) issued at signing: the offer the consumer sees. */
export function quotationIssuedRecord(f: ApplicationSubject & {
  documentSha256: string
  evidenceSha256: string
  pasqVersion: string
  termDays: number
  principalCents: number
  recurringPaymentCents: number
  totalCostOfCreditCents: number
  creditLifeElection: string
}): DecisionRecordInput {
  return {
    tenantId: f.tenantId,
    kind: "OFFER",
    decision: "QUOTATION_ISSUED",
    recommendation: "NONE",
    overrideReason: null,
    actor: staff(f.actor),
    subject: subjectOf(f),
    source: applicationSource(f),
    ruleVersion: `${DECISION_LOG_VERSION}+${f.pasqVersion}`,
    policy: {},
    snapshot: {
      amountBand: amountBand(f.principalCents),
      termDays: f.termDays,
      instalmentBand: instalmentBand(f.recurringPaymentCents),
      creditLifeElection: f.creditLifeElection,
    },
    evidenceRefs: { pasqDocumentSha256: f.documentSha256, pasqEvidenceSha256: f.evidenceSha256 },
    exactInputs: {
      principalCents: f.principalCents,
      termDays: f.termDays,
      recurringPaymentCents: f.recurringPaymentCents,
      totalCostOfCreditCents: f.totalCostOfCreditCents,
      creditLifeElection: f.creditLifeElection,
    },
    decidedAt: f.decidedAt,
  }
}
