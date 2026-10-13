import type { LoanCalcResult } from "@/lib/loan-calculator"
import { calculateLoan } from "@/lib/loan-calculator"
import { Prisma } from "@prisma/client"
import {
  lockAffordabilityApplicationEvidence,
  lockAffordabilityClientEvidence,
  lockAffordabilityTenantPolicy,
} from "@/lib/affordability/evidence-locks"
import type { prisma as ScopedPrismaClient } from "@/lib/prisma"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
import { bureauStalenessCutoff } from "@/lib/compliance/bureau"
import {
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import {
  verifyStoredCreditLifeDisclosure,
  type StoredCreditLifeDisclosure,
} from "@/lib/insurance/credit-life-election.server"
import {
  calculateCreditLifePremiumPeriods,
  createPasqBillingEvidence,
  verifyStoredPasqBinding,
  type PasqBillingEvidence,
  type StoredPasqBinding,
} from "@/lib/compliance/pasq"
import {
  bureauCheckMatchesSubject,
  type BureauSubjectClient,
} from "@/lib/compliance/bureau-subject"
import {
  APPROVAL_AFFORDABILITY_POLICY_VERSION,
  InvalidAffordabilityDebtError,
  affordabilityExpenseEvidenceIsIntact,
  affordabilityExpenseEvidenceNeedsMleJustification,
  affordabilityDecisionSnapshotIsIntact,
  approvalSnapshotMatches,
  bureauMonthlyObligations,
  calculateLoanFromDecisionInputs,
  createAffordabilityExpenseEvidence,
  createAffordabilityCalculatorEvidence,
  createAffordabilitySnapshot,
  createBureauDecisionEvidence,
  frozenApprovedTerms,
  normaliseAffordabilityDebts,
  readAffordabilityDebtInputs,
  readAffordabilitySnapshotStore,
  totalAffordabilityDebt,
  type AffordabilityDecisionSnapshot,
  type AffordabilityDebtInput,
  type AffordabilityExpenseInput,
  type BureauDecisionCheckInput,
} from "@/lib/affordability/snapshot"
import { isSimulatedBureauCheck, simulatedBureauBlock } from "@/lib/decision/bureau-simulated"
import { verifySubmissionAffordabilitySnapshot } from "@/lib/affordability/submission-snapshot"

export type CurrentApprovalEvidenceReason =
  | "missing"
  | "changed"
  | "submission_missing"
  | "submission_changed"
  | "bureau_missing"
  | "bureau_subject_changed"
  | "bureau_simulated"
  | "override_incomplete"
  | "kyc_changed"
  | "mle_justification_missing"
  | "expense_evidence_invalid"
  | "debt_evidence_invalid"
  | "affordability_failed"
  | "pasq_changed"

export interface CurrentApprovalEvidenceApplication
  extends StoredCreditLifeDisclosure, StoredPasqBinding {
  id: string
  tenantId: string
  clientId: string
  affordabilityResult: unknown
  submittedAt: Date | string | null
  appliedAmount: number
  appliedTermDays: number
  approvedAmount: number | null
  approvedTermDays: number | null
  productId: string
  initiationFeePayment: "DEFERRED" | "UPFRONT"
  existingDebtObligations: unknown
  bureauOverrideReason: string | null
  bureauOverrideById: string | null
  bureauOverrideAt: Date | string | null
  bureauReviewGeneration: string | null
  product: {
    interestRatePm: number
    interestModel: string
    initiationFeeModel: "FLAT_PCT" | "NCA_REG42"
    initiationFeePct: number
    initiationFeeMax: number
    monthlyServiceFee: number
    productType: string
  }
  client: AffordabilityExpenseInput & BureauSubjectClient & {
    debtObligations: readonly AffordabilityDebtInput[]
  }
}

/**
 * The relations `verifyCurrentAffordabilityApproval` reads. Exported because a
 * second caller — the board's readiness chip — must select exactly these or it
 * would be judging the approval on a different set of columns than the payout
 * path does.
 */
export const approvalEvidenceApplicationInclude = Prisma.validator<Prisma.LoanApplicationInclude>()({
  loan: { select: { id: true } },
  product: {
    select: {
      interestRatePm: true,
      interestModel: true,
      initiationFeeModel: true,
      initiationFeePct: true,
      initiationFeeMax: true,
      monthlyServiceFee: true,
      productType: true,
    },
  },
  client: {
    select: {
      id: true,
      idNumber: true,
      firstName: true,
      lastName: true,
      gender: true,
      dateOfBirth: true,
      updatedAt: true,
      kycStatus: true,
      kycVerifiedAt: true,
      kycVerifiedById: true,
      kycVerificationMethod: true,
      kycManualRejectionActive: true,
      kycManualRejectionAt: true,
      kycManualRejectionById: true,
      kycManualRejectionReason: true,
      kycManualRejectionResolvedAt: true,
      kycManualRejectionResolvedById: true,
      kycManualRejectionResolutionReason: true,
      grossMonthlyIncome: true,
      monthlyIncome: true,
      monthlyExpenses: true,
      expenseBreakdown: {
        select: {
          id: true,
          updatedAt: true,
          housing: true,
          transport: true,
          food: true,
          education: true,
          insurance: true,
          clothing: true,
          entertainment: true,
          medical: true,
          other: true,
          belowMleJustification: true,
        },
      },
      debtObligations: {
        select: {
          id: true,
          creditProvider: true,
          accountType: true,
          outstandingBalance: true,
          monthlyInstalment: true,
          notes: true,
        },
      },
    },
  },
})

export type LockedApprovalApplication = Prisma.LoanApplicationGetPayload<{
  include: typeof approvalEvidenceApplicationInclude
}>

type ApprovalEvidenceTransaction = Parameters<
  Parameters<typeof ScopedPrismaClient.$transaction>[0]
>[0]

type LockedApprovalContext = {
  application: LockedApprovalApplication
  bureauCheck: Prisma.CreditBureauCheckGetPayload<Record<string, never>> | null
  tenantConfig: Pick<
    Prisma.TenantConfigGetPayload<Record<string, never>>,
    "ndiBufferPct" | "bureauMinScore" | "bureauBlockAdverse"
  > | null
}

/**
 * Serialize every final approval/agreement/signing write with the mutable rows
 * that feed affordability. The application advisory lock also coordinates
 * bureau-result inserts (which have no application FK), while row locks block
 * client/profile, product, and policy updates until the state write commits.
 */
async function loadLockedApprovalContext(
  tx: ApprovalEvidenceTransaction,
  args: { tenantId: string; applicationId: string },
): Promise<LockedApprovalContext | null> {
  await lockAffordabilityApplicationEvidence(tx, args)
  // A row lock cannot protect the legacy/default case where TenantConfig does
  // not exist yet. The credit-policy writer takes this same tenant-scoped lock
  // before an upsert, so creating the first policy row cannot race a decision
  // that evaluated the schema defaults.
  await lockAffordabilityTenantPolicy(tx, { tenantId: args.tenantId })
  const applicationRows = await tx.$queryRaw<Array<{
    id: string
    clientId: string
    productId: string
    bureauReviewGeneration: string | null
  }>>(Prisma.sql`
    SELECT "id", "clientId", "productId", "bureauReviewGeneration"
    FROM "LoanApplication"
    WHERE "id" = ${args.applicationId} AND "tenantId" = ${args.tenantId}
    FOR UPDATE
  `)
  const identity = applicationRows[0]
  if (!identity) return null

  await lockAffordabilityClientEvidence(tx, {
    tenantId: args.tenantId,
    clientId: identity.clientId,
  })

  const [clientRows, productRows] = await Promise.all([
    tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Client"
      WHERE "id" = ${identity.clientId} AND "tenantId" = ${args.tenantId}
      FOR SHARE
    `),
    tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "LoanProduct"
      WHERE "id" = ${identity.productId} AND "tenantId" = ${args.tenantId}
      FOR SHARE
    `),
  ])
  if (!clientRows[0] || !productRows[0]) return null

  // The row normally exists. FOR SHARE coordinates policy edits; when a
  // legacy tenant has no config, defaults remain authoritative for this write.
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "TenantConfig"
    WHERE "tenantId" = ${args.tenantId}
    FOR SHARE
  `)

  const [application, bureauCheck, tenantConfig] = await Promise.all([
    tx.loanApplication.findUnique({
      where: { id: args.applicationId, tenantId: args.tenantId },
      include: approvalEvidenceApplicationInclude,
    }),
    identity.bureauReviewGeneration
      ? tx.creditBureauCheck.findFirst({
          where: {
            tenantId: args.tenantId,
            applicationId: args.applicationId,
            clientId: identity.clientId,
            reviewGeneration: identity.bureauReviewGeneration,
            ok: true,
            createdAt: { gte: bureauStalenessCutoff() },
            provider: "experian",
          },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve(null),
    tx.tenantConfig.findUnique({
      where: { tenantId: args.tenantId },
      select: {
        ndiBufferPct: true,
        bureauMinScore: true,
        bureauBlockAdverse: true,
      },
    }),
  ])
  if (!application) return null
  return { application, bureauCheck, tenantConfig }
}

export type LockedCurrentApprovalResult =
  | ({ ok: true; application: LockedApprovalApplication } &
      Extract<CurrentApprovalEvidenceResult, { ok: true }>)
  | { ok: false; reason: CurrentApprovalEvidenceReason | "application_changed" }

/**
 * Which grade of KYC evidence a transition demands.
 *
 * "origination" — four core documents, no manual rejection. Biometrics are not
 * required to approve an application (policy), so the cached
 * kycStatus projection is deliberately NOT consulted either: a client with no
 * selfie yet projects PENDING, which is correct and must not block approval.
 *
 * "payout" — the strict composite: documents plus a valid biometric or a
 * recorded substitute, and a cached projection that agrees. Required to
 * generate or sign the agreement and to disburse.
 */
export type KycEvidenceGrade = "origination" | "payout"

async function hasCurrentCompositeKyc(
  tx: ApprovalEvidenceTransaction,
  application: LockedApprovalApplication,
  grade: KycEvidenceGrade,
): Promise<boolean> {
  if (grade === "payout" && application.client.kycStatus !== "VERIFIED") return false
  const composite = await readCompositeKycState(
    tx as unknown as CompositeKycReader,
    {
      tenantId: application.tenantId,
      clientId: application.clientId,
      subject: application.client,
      existing: application.client,
      preserveVerifiedProvenance: true,
    },
  )
  return grade === "payout" ? composite.ok : composite.okForOrigination
}

export async function verifyLockedCurrentAffordabilityApproval(
  tx: ApprovalEvidenceTransaction,
  args: {
    tenantId: string
    applicationId: string
    requirePasqAcknowledgement?: boolean
  },
): Promise<LockedCurrentApprovalResult> {
  const context = await loadLockedApprovalContext(tx, args)
  if (!context || context.application.status !== "APPROVED") {
    return { ok: false, reason: "application_changed" }
  }
  // Agreement generation, signing and disbursement: strict. This is the gate
  // that has always required identity evidence before the consumer is bound.
  if (!await hasCurrentCompositeKyc(tx, context.application, "payout")) {
    return { ok: false, reason: "kyc_changed" }
  }
  if (
    context.bureauCheck &&
    !bureauCheckMatchesSubject(context.bureauCheck, context.application.client)
  ) {
    return { ok: false, reason: "bureau_subject_changed" }
  }
  const verified = verifyCurrentAffordabilityApproval({
    ...context,
    requirePasqAcknowledgement: args.requirePasqAcknowledgement,
  })
  if (!verified.ok) return verified
  return { ...verified, application: context.application }
}

export type LockedApprovalCandidateResult =
  | { ok: true; application: LockedApprovalApplication }
  | {
      ok: false
      reason:
        | CurrentApprovalEvidenceReason
        | "application_changed"
        | "kyc_changed"
        | "compliance_changed"
    }

/**
 * Rebuild the proposed approval snapshot after acquiring the evidence locks.
 * Matching its cryptographic decision fingerprint proves that the exact
 * income, expense, debt, bureau, pricing and policy inputs evaluated before
 * the transaction are still current at the state write.
 */
export async function verifyLockedApprovalCandidate(
  tx: ApprovalEvidenceTransaction,
  args: {
    tenantId: string
    applicationId: string
    expectedApplicationUpdatedAt: Date | string
    expectedApproval: AffordabilityDecisionSnapshot
    capturedAt: Date
    calculationStartDate: Date
    capturedById: string
    bureauOverrideReason: string | null
    // `null` means "no PASQ exists yet" — the approval stage, since the PASQ is
    // now minted at the signing ceremony. Required rather than optional so the
    // compiler forces every call site to state which case it is in.
    expectedPasqDocumentSha256: string | null
  },
): Promise<LockedApprovalCandidateResult> {
  const context = await loadLockedApprovalContext(tx, args)
  if (!context) return { ok: false, reason: "application_changed" }
  const { application, bureauCheck, tenantConfig } = context
  if (
    application.status !== "UNDER_REVIEW" ||
    application.loan ||
    application.updatedAt.toISOString() !== new Date(args.expectedApplicationUpdatedAt).toISOString()
  ) {
    return { ok: false, reason: "application_changed" }
  }
  // Approval does not require biometrics; signing and payout do, and they run
  // through verifyLockedCurrentAffordabilityApproval which stays "payout".
  if (!await hasCurrentCompositeKyc(tx, application, "origination")) {
    return { ok: false, reason: "kyc_changed" }
  }
  // The PASQ acknowledgement is required only once a quotation is expected to
  // exist. At approval (expectedPasqDocumentSha256 === null) it has not been
  // issued yet — it is issued at the signing ceremony. Every caller that runs
  // after the ceremony passes a digest and still demands the acknowledgement.
  if (
    args.expectedPasqDocumentSha256 !== null &&
    (!application.pasqAcknowledgedAt || !application.pasqAcknowledgedBy)
  ) {
    return { ok: false, reason: "compliance_changed" }
  }
  if (
    !application.clientAffordabilityDeclaredAt ||
    !application.recklessLendingAssessed ||
    !application.recklessLendingAssessedAt ||
    !application.recklessLendingAssessedById
  ) {
    return { ok: false, reason: "compliance_changed" }
  }
  const creditLife = verifyStoredCreditLifeDisclosure(application, {
    principalCents: application.appliedAmount,
    termDays: application.appliedTermDays,
  })
  if (!creditLife.ok) {
    return { ok: false, reason: "compliance_changed" }
  }
  const submission = readAffordabilitySnapshotStore(application.affordabilityResult).submission
  if (!submission || !application.submittedAt) {
    return { ok: false, reason: "submission_missing" }
  }
  if (
    submission.stage !== "SUBMISSION" ||
    submission.capturedAt !== application.submittedAt.toISOString() ||
    !affordabilityDecisionSnapshotIsIntact(submission)
  ) {
    return { ok: false, reason: "submission_changed" }
  }
  if (!bureauCheck && !args.bureauOverrideReason) {
    return { ok: false, reason: "bureau_missing" }
  }
  if (
    bureauCheck &&
    !bureauCheckMatchesSubject(bureauCheck, application.client)
  ) {
    return { ok: false, reason: "bureau_subject_changed" }
  }
  if (simulatedBureauBlock(isSimulatedBureauCheck(bureauCheck?.obligations)).blocked) {
    return { ok: false, reason: "bureau_simulated" }
  }

  const expenseEvidence = createAffordabilityExpenseEvidence(application.client)
  if (affordabilityExpenseEvidenceNeedsMleJustification(expenseEvidence)) {
    return { ok: false, reason: "mle_justification_missing" }
  }
  if (!affordabilityExpenseEvidenceIsIntact(expenseEvidence)) {
    return { ok: false, reason: "expense_evidence_invalid" }
  }

  let calculation: LoanCalcResult
  try {
    calculation = calculateLoan({
      principal: application.appliedAmount,
      termDays: application.appliedTermDays,
      interestRatePm: application.product.interestRatePm,
      productType: application.product.productType,
      interestModel: application.product.interestModel,
      initiationFeeModel: application.product.initiationFeeModel,
      initiationFeePct: application.product.initiationFeePct,
      initiationFeeMax: application.product.initiationFeeMax,
      monthlyServiceFee: application.product.monthlyServiceFee,
      initiationFeePayment: application.initiationFeePayment,
    }, args.calculationStartDate)
  } catch {
    return { ok: false, reason: "changed" }
  }
  const calculatorEvidence = createAffordabilityCalculatorEvidence(
    calculation,
    args.calculationStartDate,
  )
  // NCA s.92(1) requires the quotation before the agreement is ENTERED INTO,
  // not before the internal credit decision. The PASQ is therefore minted at
  // the signing ceremony, so at approval there is no document to bind to. The
  // credit-life-inclusive instalment is derived from the same billing helper
  // the PASQ itself will use, so the figure approved and the figure quoted are
  // produced by one code path and cannot drift.
  let recurringPaymentCents: number
  if (args.expectedPasqDocumentSha256 === null) {
    let billing: PasqBillingEvidence
    try {
      billing = createPasqBillingEvidence({
        calculator: calculatorEvidence,
        election: creditLife.evidence.election,
        // MUST branch on `offered` (see VerifiedCreditLifeEvidence): a
        // no-offer disclosure is DECLINED + premium 0, which the helper
        // rejects when `offered` defaults to true.
        offered: creditLife.evidence.offered,
        monthlyPremiumCents: creditLife.evidence.monthlyPremiumCents,
        premiumPeriods: calculateCreditLifePremiumPeriods(
          calculatorEvidence,
          application.appliedTermDays,
        ),
      })
    } catch {
      return { ok: false, reason: "changed" }
    }
    recurringPaymentCents = billing.recurringPaymentCents
  } else {
    const pasq = verifyStoredPasqBinding(application, {
      tenantId: application.tenantId,
      applicationId: application.id,
      clientId: application.clientId,
      productId: application.productId,
      calculatorPricingFingerprint: calculatorEvidence.pricingFingerprint,
      creditLifeDisclosureSha256: creditLife.evidence.disclosureSha256,
    })
    if (
      !pasq.ok
      || pasq.documentSha256 !== args.expectedPasqDocumentSha256
    ) {
      return { ok: false, reason: "compliance_changed" }
    }
    recurringPaymentCents = pasq.evidence.billing.recurringPaymentCents
  }
  const creditLifePremiumCents =
    recurringPaymentCents - calculation.monthlyInstalment

  let applicationDebts: ReturnType<typeof normaliseAffordabilityDebts>
  let clientDebts: ReturnType<typeof normaliseAffordabilityDebts>
  let applicationDebtCents: number
  let clientDebtCents: number
  try {
    applicationDebts = normaliseAffordabilityDebts(
      readAffordabilityDebtInputs(application.existingDebtObligations),
    )
    clientDebts = normaliseAffordabilityDebts(application.client.debtObligations)
    applicationDebtCents = totalAffordabilityDebt(applicationDebts)
    clientDebtCents = totalAffordabilityDebt(clientDebts)
  } catch (error) {
    if (error instanceof InvalidAffordabilityDebtError) {
      return { ok: false, reason: "debt_evidence_invalid" }
    }
    throw error
  }
  const inputs = {
    monthlyIncomeCents: application.client.monthlyIncome,
    monthlyExpensesCents: application.client.monthlyExpenses,
    applicationDebtCents,
    clientDebtCents,
    declaredDebtCents: Math.max(applicationDebtCents, clientDebtCents),
    bureauObligationsCents: bureauMonthlyObligations(bureauCheck?.obligations),
    proposedInstalmentCents: recurringPaymentCents,
    creditLifePremiumCents,
    principalCents: application.appliedAmount,
    termDays: application.appliedTermDays,
    productId: application.productId,
    interestRatePm: application.product.interestRatePm,
    interestModel: application.product.interestModel,
    initiationFeeModel: application.product.initiationFeeModel,
    initiationFeePct: application.product.initiationFeePct,
    initiationFeeMaxCents: application.product.initiationFeeMax,
    monthlyServiceFeeCents: application.product.monthlyServiceFee,
    productType: application.product.productType,
    initiationFeePayment: application.initiationFeePayment,
    ndiBufferPct: tenantConfig?.ndiBufferPct ?? 110,
  }
  const affordability = evaluateAffordabilityGate(inputs)
  if (affordability.blocked) return { ok: false, reason: "affordability_failed" }
  const bureauEvidence = createBureauDecisionEvidence({
    check: bureauCheck,
    minimumScore: tenantConfig?.bureauMinScore ?? 450,
    blockAdverse: tenantConfig?.bureauBlockAdverse ?? false,
    override: args.bureauOverrideReason
      ? {
          reason: args.bureauOverrideReason,
          byId: args.capturedById,
          at: args.capturedAt,
        }
      : null,
  })
  const currentApproval = createAffordabilitySnapshot({
    stage: "APPROVAL",
    policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
    capturedAt: args.capturedAt,
    capturedById: args.capturedById,
    inputs,
    applicationDebts,
    clientDebts,
    expenseEvidence,
    bureauEvidence,
    calculation,
    calculationStartDate: args.calculationStartDate,
    outcome: {
      netDisposableIncomeCents: affordability.ndi,
      ndiAfterLoanCents:
        affordability.ndi - recurringPaymentCents,
      requiredNdiCents: affordability.requiredNdi,
      isAffordable: !affordability.blocked,
      reason: affordability.reason ?? null,
    },
  })
  if (currentApproval.decisionFingerprint !== args.expectedApproval.decisionFingerprint) {
    return { ok: false, reason: "changed" }
  }
  return { ok: true, application }
}

export type CurrentApprovalEvidenceResult =
  | {
      ok: true
      approval: AffordabilityDecisionSnapshot
      calculation: LoanCalcResult
    }
  | { ok: false; reason: CurrentApprovalEvidenceReason }

/**
 * Compare every mutable decision input with the immutable approval snapshot.
 * Agreement generation, signing, and payout all call this same pure gate so a
 * stale decision cannot progress farther merely because a route forgot a field.
 */
export function verifyCurrentAffordabilityApproval(args: {
  application: CurrentApprovalEvidenceApplication
  bureauCheck: BureauDecisionCheckInput | null
  tenantConfig: {
    ndiBufferPct: number
    bureauMinScore: number
    bureauBlockAdverse: boolean
  } | null
  requirePasqAcknowledgement?: boolean
}): CurrentApprovalEvidenceResult {
  const { application, bureauCheck, tenantConfig } = args
  const submissionCheck = verifySubmissionAffordabilitySnapshot(application)
  if (!submissionCheck.ok) return submissionCheck
  const hasBureauOverride = application.bureauOverrideAt != null
  if (!bureauCheck && !hasBureauOverride) {
    return { ok: false, reason: "bureau_missing" }
  }
  if (bureauCheck && !bureauCheckMatchesSubject(bureauCheck, application.client)) {
    return { ok: false, reason: "bureau_subject_changed" }
  }
  if (simulatedBureauBlock(isSimulatedBureauCheck(bureauCheck?.obligations)).blocked) {
    return { ok: false, reason: "bureau_simulated" }
  }
  if (
    hasBureauOverride &&
    (!application.bureauOverrideReason?.trim() || !application.bureauOverrideById)
  ) {
    return { ok: false, reason: "override_incomplete" }
  }

  const creditLife = verifyStoredCreditLifeDisclosure(application, {
    principalCents: application.appliedAmount,
    termDays: application.appliedTermDays,
  })
  if (!creditLife.ok || !(application.pasqGeneratedAt instanceof Date)) {
    return { ok: false, reason: "pasq_changed" }
  }

  // Price this loan on the terms frozen when it was approved, NOT on the
  // product row as it stands now. See frozenApprovedTerms.
  const frozenTerms = frozenApprovedTerms(application.affordabilityResult)
  if (!frozenTerms.ok) return { ok: false, reason: frozenTerms.reason }
  const frozen = frozenTerms.terms

  let calculation: LoanCalcResult
  try {
    calculation = calculateLoanFromDecisionInputs(frozen, application.pasqGeneratedAt)
  } catch {
    return { ok: false, reason: "changed" }
  }
  const calculatorEvidence = createAffordabilityCalculatorEvidence(
    calculation,
    application.pasqGeneratedAt,
  )
  const pasq = verifyStoredPasqBinding(application, {
    tenantId: application.tenantId,
    applicationId: application.id,
    clientId: application.clientId,
    productId: application.productId,
    calculatorPricingFingerprint: calculatorEvidence.pricingFingerprint,
    creditLifeDisclosureSha256: creditLife.evidence.disclosureSha256,
    requireAcknowledgement: args.requirePasqAcknowledgement ?? true,
    requireApprovalBinding: args.requirePasqAcknowledgement ?? true,
  })
  if (!pasq.ok) return { ok: false, reason: "pasq_changed" }
  const creditLifePremiumCents =
    pasq.evidence.billing.recurringPaymentCents - calculation.monthlyInstalment

  let applicationDebts: ReturnType<typeof normaliseAffordabilityDebts>
  let clientDebts: ReturnType<typeof normaliseAffordabilityDebts>
  let applicationDebtCents: number
  let clientDebtCents: number
  try {
    applicationDebts = normaliseAffordabilityDebts(
      readAffordabilityDebtInputs(application.existingDebtObligations),
    )
    clientDebts = normaliseAffordabilityDebts(application.client.debtObligations)
    applicationDebtCents = totalAffordabilityDebt(applicationDebts)
    clientDebtCents = totalAffordabilityDebt(clientDebts)
  } catch (error) {
    if (error instanceof InvalidAffordabilityDebtError) {
      return { ok: false, reason: "debt_evidence_invalid" }
    }
    throw error
  }
  const expenseEvidence = createAffordabilityExpenseEvidence(application.client)
  if (affordabilityExpenseEvidenceNeedsMleJustification(expenseEvidence)) {
    return { ok: false, reason: "mle_justification_missing" }
  }
  if (!affordabilityExpenseEvidenceIsIntact(expenseEvidence)) {
    return { ok: false, reason: "expense_evidence_invalid" }
  }

  const bureauEvidence = createBureauDecisionEvidence({
    check: bureauCheck,
    minimumScore: tenantConfig?.bureauMinScore ?? 450,
    blockAdverse: tenantConfig?.bureauBlockAdverse ?? false,
    override: hasBureauOverride
      ? {
          reason: application.bureauOverrideReason!.trim(),
          byId: application.bureauOverrideById!,
          at: application.bureauOverrideAt!,
        }
      : null,
  })
  const approvalSnapshot = approvalSnapshotMatches(application.affordabilityResult, {
    inputs: {
      monthlyIncomeCents: application.client.monthlyIncome,
      monthlyExpensesCents: application.client.monthlyExpenses,
      applicationDebtCents,
      clientDebtCents,
      declaredDebtCents: Math.max(applicationDebtCents, clientDebtCents),
      bureauObligationsCents: bureauMonthlyObligations(bureauCheck?.obligations),
      proposedInstalmentCents: pasq.evidence.billing.recurringPaymentCents,
      creditLifePremiumCents,
      // Agreed loan terms: frozen. Everything above this line describes the
      // CONSUMER and stays live, so debt/income/expense drift after approval
      // still breaks the fingerprint and still blocks — only the lender's own
      // product maintenance is prevented from doing so.
      principalCents: frozen.principalCents,
      termDays: frozen.termDays,
      // Live: a product SWAP is a real tamper, and verifyStoredPasqBinding
      // compares this against the quotation the consumer actually acknowledged.
      productId: application.productId,
      interestRatePm: frozen.interestRatePm,
      productType: frozen.productType,
      interestModel: frozen.interestModel,
      initiationFeeModel: frozen.initiationFeeModel,
      initiationFeePct: frozen.initiationFeePct,
      initiationFeeMaxCents: frozen.initiationFeeMaxCents,
      monthlyServiceFeeCents: frozen.monthlyServiceFeeCents,
      initiationFeePayment: frozen.initiationFeePayment,
      ndiBufferPct: tenantConfig?.ndiBufferPct ?? 110,
    },
    applicationDebts,
    clientDebts,
    expenseEvidence,
    bureauEvidence,
    calculation,
  })
  if (!approvalSnapshot.ok) return approvalSnapshot
  if (!approvalSnapshot.snapshot.outcome.isAffordable) {
    return { ok: false, reason: "affordability_failed" }
  }
  return {
    ok: true,
    approval: approvalSnapshot.snapshot,
    calculation,
  }
}
