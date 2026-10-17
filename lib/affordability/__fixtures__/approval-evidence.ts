import { calculateLoan } from "@/lib/loan-calculator"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
import {
  APPROVAL_AFFORDABILITY_POLICY_VERSION,
  createAffordabilityExpenseEvidence,
  createAffordabilityCalculatorEvidence,
  createAffordabilityContractEvidence,
  createAffordabilitySnapshot,
  createBureauDecisionEvidence,
  createSubmissionAffordabilitySnapshot,
  normaliseAffordabilityDebts,
  totalAffordabilityDebt,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import { bureauSubjectFingerprint } from "@/lib/compliance/bureau-subject"
import { CREDIT_LIFE_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { createPasqEvidence } from "@/lib/compliance/pasq"
import { withOwnLenderDebts, type OwnLenderDebts } from "@/lib/affordability/own-lender-debt"

/**
 * One APPROVED application whose approval evidence actually verifies.
 *
 * Assembling this by hand is ~200 lines of interlocking digests — the
 * affordability snapshot, the contract, the PASQ binding and the credit-life
 * disclosure all hash each other — so a second copy would not merely be
 * duplication, it would be a second copy that quietly stops verifying. It grew
 * up inside `current-approval.test.ts`; the board's readiness chip is the
 * second caller that needs a genuinely-passing approval, and it must exercise
 * the SAME fixture or "READY" would be proven against a shape the payout path
 * would reject.
 */
export const capturedAt = new Date("2026-07-20T10:00:00.000Z")
export const submittedAt = new Date("2026-07-20T09:00:00.000Z")
export const pasqGeneratedAt = new Date("2026-07-20T09:15:00.000Z")
export const applicationUpdatedAt = new Date("2026-07-20T09:30:00.000Z")
export const pasqDocumentSha256 = "d".repeat(64)

export const product = {
  productType: "PERSONAL",
  interestRatePm: 0.03,
  // Widened to the real column's union rather than the literal: a LoanProduct's
  // interest model is editable, and a fixture that pins it to one literal cannot
  // express the post-approval product edit these tests exist to cover.
  interestModel: "REDUCING_BALANCE" as "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL",
  initiationFeeModel: "FLAT_PCT" as const,
  initiationFeePct: 0.15,
  initiationFeeMax: 105_000,
  monthlyServiceFee: 6_900,
}

export const expenseBreakdown = {
  id: "expense-1",
  updatedAt: new Date("2026-07-20T08:00:00.000Z"),
  housing: 400_000,
  transport: 150_000,
  food: 150_000,
  education: 0,
  insurance: 50_000,
  clothing: 0,
  entertainment: 0,
  medical: 50_000,
  other: 0,
  belowMleJustification: null,
}

export const debt = {
  id: "debt-1",
  creditProvider: "Bank A",
  accountType: "PERSONAL_LOAN",
  outstandingBalance: 500_000,
  monthlyInstalment: 50_000,
  notes: "Declared debt",
}

export const applicationDebt = {
  sourceId: debt.id,
  provider: debt.creditProvider,
  type: debt.accountType,
  balance: debt.outstandingBalance,
  monthlyInstalment: debt.monthlyInstalment,
  notes: debt.notes,
}

export const client = {
  id: "client-1",
  idNumber: "9001015800086",
  firstName: "Jane",
  lastName: "Doe",
  gender: "FEMALE" as const,
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-20T08:30:00.000Z"),
  kycStatus: "VERIFIED" as "VERIFIED" | "PENDING" | "FAILED" | "EXPIRED",
  kycVerifiedAt: new Date("2026-07-20T08:20:00.000Z"),
  kycVerifiedById: null,
  kycVerificationMethod: "SMILE_IDENTITY" as const,
  grossMonthlyIncome: 1_700_000,
  monthlyIncome: 1_500_000,
  monthlyExpenses: 800_000,
  expenseBreakdown,
  debtObligations: [debt],
}

export const bureauCheck = {
  id: "bureau-1",
  tenantId: "tenant-1",
  clientId: "client-1",
  applicationId: "application-1",
  reviewGeneration: "review-generation-1",
  subjectFingerprint: bureauSubjectFingerprint(client),
  provider: "experian",
  score: 612,
  riskGrade: "LOW",
  adverseInfo: [],
  hasAdverse: false,
  deceased: false,
  underDebtReview: false,
  hasJudgement: false,
  hasNotice: false,
  unscoreable: false,
  declineReasons: [],
  ok: true,
  errorMessage: null,
  obligations: { totalMonthly: 25_000 },
  createdAt: new Date("2026-07-20T09:45:00.000Z"),
}

export const tenantConfig = {
  ndiBufferPct: 110,
  bureauMinScore: 450,
  bureauBlockAdverse: false,
}

export const creditLifeDisclosure = {
  version: "credit-life-election-v1" as const,
  election: "DECLINED" as const,
  principalCents: 500_000,
  termDays: 90,
  monthlyPremiumCents: 2_250,
  productId: "credit-life-1",
  productName: "Acme Credit Life",
  insurerId: "insurer-1",
  insurerName: "Test Life",
}

export function buildEvidence(
  override: { reason: string; byId: string; at: Date } | null = null,
  ownLenderDebts: OwnLenderDebts = { lenderNames: [], loans: [] },
) {
  const calculation = calculateLoan({
    principal: 500_000,
    termDays: 90,
    ...product,
    initiationFeePayment: "DEFERRED",
  }, pasqGeneratedAt)
  const applicationDebts = normaliseAffordabilityDebts(withOwnLenderDebts([applicationDebt], ownLenderDebts))
  const clientDebts = normaliseAffordabilityDebts(withOwnLenderDebts([debt], ownLenderDebts))
  const applicationDebtCents = totalAffordabilityDebt(applicationDebts)
  const clientDebtCents = totalAffordabilityDebt(clientDebts)
  const inputs = {
    monthlyIncomeCents: client.monthlyIncome,
    monthlyExpensesCents: client.monthlyExpenses,
    applicationDebtCents,
    clientDebtCents,
    declaredDebtCents: Math.max(applicationDebtCents, clientDebtCents),
    bureauObligationsCents: 25_000,
    proposedInstalmentCents: calculation.monthlyInstalment,
    creditLifePremiumCents: 0,
    principalCents: 500_000,
    termDays: 90,
    productId: "product-1",
    interestRatePm: product.interestRatePm,
    productType: product.productType,
    interestModel: product.interestModel,
    initiationFeeModel: product.initiationFeeModel,
    initiationFeePct: product.initiationFeePct,
    initiationFeeMaxCents: product.initiationFeeMax,
    monthlyServiceFeeCents: product.monthlyServiceFee,
    initiationFeePayment: "DEFERRED" as const,
    ndiBufferPct: tenantConfig.ndiBufferPct,
  }
  const affordability = evaluateAffordabilityGate(inputs)
  const approval = createAffordabilitySnapshot({
    stage: "APPROVAL",
    policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
    capturedAt,
    capturedById: "officer-1",
    inputs,
    applicationDebts,
    clientDebts,
    expenseEvidence: createAffordabilityExpenseEvidence(client),
    bureauEvidence: createBureauDecisionEvidence({
      check: bureauCheck,
      minimumScore: tenantConfig.bureauMinScore,
      blockAdverse: tenantConfig.bureauBlockAdverse,
      override,
    }),
    calculation,
    calculationStartDate: pasqGeneratedAt,
    outcome: {
      netDisposableIncomeCents: affordability.ndi,
      ndiAfterLoanCents: affordability.ndi - calculation.monthlyInstalment,
      requiredNdiCents: affordability.requiredNdi,
      isAffordable: !affordability.blocked,
      reason: affordability.reason ?? null,
    },
  })
  const submission = createSubmissionAffordabilitySnapshot({
    capturedAt: submittedAt,
    capturedById: "officer-1",
    client,
    applicationDebts: [applicationDebt],
    clientDebts: [debt],
    application: {
      appliedAmount: 500_000,
      appliedTermDays: 90,
      productId: "product-1",
      initiationFeePayment: "DEFERRED",
      creditLifeMonthlyPremiumCents: 0,
    },
    product,
  })
  return { approval, submission }
}

export function applicationFixture(
  status: "UNDER_REVIEW" | "APPROVED",
  bureauOverrideReason: string | null = null,
  ownLenderDebts?: OwnLenderDebts,
) {
  const override = bureauOverrideReason
    ? { reason: bureauOverrideReason, byId: "officer-1", at: capturedAt }
    : null
  const { approval, submission } = buildEvidence(override, ownLenderDebts)
  let affordabilityResult = withAffordabilitySnapshot(null, submission)
  if (status === "APPROVED") {
    affordabilityResult = withAffordabilitySnapshot(affordabilityResult, approval)
  }
  const pasqEvidence = createPasqEvidence({
    tenantId: "tenant-1",
    applicationId: "application-1",
    clientId: "client-1",
    productId: "product-1",
    termDays: 90,
    generatedAt: pasqGeneratedAt,
    calculator: createAffordabilityCalculatorEvidence(
      calculateLoan({
        principal: 500_000,
        termDays: 90,
        ...product,
        initiationFeePayment: "DEFERRED",
      }, pasqGeneratedAt),
      pasqGeneratedAt,
    ),
    creditLife: {
      election: creditLifeDisclosure.election,
      productId: creditLifeDisclosure.productId,
      productName: creditLifeDisclosure.productName,
      insurerId: creditLifeDisclosure.insurerId,
      insurerName: creditLifeDisclosure.insurerName,
      monthlyPremiumCents: creditLifeDisclosure.monthlyPremiumCents,
      disclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
      disclosureSha256: createCreditLifeDisclosureSha256(creditLifeDisclosure),
    },
  })
  return {
    id: "application-1",
    tenantId: "tenant-1",
    clientId: "client-1",
    productId: "product-1",
    status,
    loan: null,
    updatedAt: applicationUpdatedAt,
    submittedAt,
    appliedAmount: 500_000,
    appliedTermDays: 90,
    approvedAmount: status === "APPROVED" ? 500_000 : null,
    approvedTermDays: status === "APPROVED" ? 90 : null,
    initiationFeePayment: "DEFERRED" as const,
    creditLifeElection: creditLifeDisclosure.election,
    creditLifeProductId: creditLifeDisclosure.productId,
    creditLifeProductName: creditLifeDisclosure.productName,
    creditLifeInsurerId: creditLifeDisclosure.insurerId,
    creditLifeInsurerName: creditLifeDisclosure.insurerName,
    creditLifeMonthlyPremiumCents: creditLifeDisclosure.monthlyPremiumCents,
    creditLifeDisclosureVersion: creditLifeDisclosure.version,
    creditLifeDisclosureSha256:
      createCreditLifeDisclosureSha256(creditLifeDisclosure),
    creditLifeDisclosureAcknowledgedAt: new Date("2026-07-20T09:05:00.000Z"),
    creditLifeDisclosureAcknowledgedBy: "client-1",
    pasqVersion: pasqEvidence.version,
    pasqGeneratedAt,
    pasqDocumentId: "pasq-document-1",
    pasqDocumentSha256,
    pasqEvidence,
    pasqEvidenceSha256: pasqEvidence.evidenceSha256,
    existingDebtObligations: [applicationDebt],
    affordabilityResult,
    pasqAcknowledgedAt: new Date("2026-07-20T09:20:00.000Z"),
    pasqAcknowledgedBy: "client-1",
    pasqAcknowledgedSha256: pasqDocumentSha256,
    approvedPasqDocumentSha256: status === "APPROVED" ? pasqDocumentSha256 : null,
    clientAffordabilityDeclaredAt: new Date("2026-07-20T09:10:00.000Z"),
    recklessLendingAssessed: true,
    recklessLendingAssessedAt: new Date("2026-07-20T09:20:00.000Z"),
    recklessLendingAssessedById: "officer-1",
    bureauOverrideReason,
    bureauOverrideById: bureauOverrideReason ? "officer-1" : null,
    bureauOverrideAt: bureauOverrideReason ? capturedAt : null,
    bureauReviewGeneration: "review-generation-1",
    product,
    client,
  }
}

/**
 * The same application, carried one step further: contract evidence
 * established over the approval, so `verifyCurrentDisbursementEvidence`
 * returns ok. `applicationFixture("APPROVED")` stops at the approval snapshot —
 * correct for the approval gate, but the payout gate also needs the contract
 * the signed agreement was cut from.
 */
export function disbursementApplicationFixture(
  overrides: { repaymentMethod?: "EFT" | "DEBIT_ORDER" } = {},
) {
  const application = applicationFixture("APPROVED")
  const { approval } = buildEvidence(null)
  const contract = createAffordabilityContractEvidence(approval, pasqGeneratedAt, {
    documentSha256: pasqDocumentSha256,
    calculator: approval.calculator,
  })
  return {
    ...application,
    agreementGeneratedAt: pasqGeneratedAt,
    repaymentMethod: overrides.repaymentMethod ?? ("DEBIT_ORDER" as const),
    affordabilityResult: { ...application.affordabilityResult, contract },
  }
}
