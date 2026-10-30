import {
  CREDIT_LIFE_DISCLOSURE_VERSION,
  CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
} from "@/lib/insurance/credit-life-election"
import { afterEach, describe, expect, it, vi } from "vitest"
import { calculateLoan } from "@/lib/loan-calculator"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
import {
  APPROVAL_AFFORDABILITY_POLICY_VERSION,
  createAffordabilityExpenseEvidence,
  createAffordabilityCalculatorEvidence,
  createAffordabilitySnapshot,
  createBureauDecisionEvidence,
  normaliseAffordabilityDebts,
  totalAffordabilityDebt,
} from "@/lib/affordability/snapshot"
import {
  verifyCurrentAffordabilityApproval,
  verifyLockedApprovalCandidate,
  verifyLockedCurrentAffordabilityApproval,
} from "@/lib/affordability/current-approval"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { PASSING_FACE_MODEL_EVIDENCE } from "@/lib/kyc/face-model/evidence.test-helpers"
import {
  createCreditLifeDisclosureSha256,
  createCreditLifeNoOfferDisclosureSha256,
} from "@/lib/insurance/credit-life-election.server"
import { verifyCurrentDisbursementEvidence } from "@/lib/affordability/current-disbursement"
import {
  calculateCreditLifePremiumPeriods,
  createPasqBillingEvidence,
  createPasqEvidence,
} from "@/lib/compliance/pasq"

import {
  applicationDebt,
  applicationFixture,
  disbursementApplicationFixture,
  applicationUpdatedAt,
  bureauCheck,
  buildEvidence,
  capturedAt,
  client,
  creditLifeDisclosure,
  debt,
  pasqDocumentSha256,
  pasqGeneratedAt,
  product,
  tenantConfig,
} from "@/lib/affordability/__fixtures__/approval-evidence"

const verifiedCoreDocuments = [
  "ID_COPY",
  "PROOF_OF_ADDRESS",
  "PAYSLIP",
  "BANK_STATEMENT",
].map((docType) => ({
  docType,
  verified: true,
  verificationNote: null,
  // The ID copy the passing selfie was compared against.
  ...(docType === "ID_COPY" && { id: "id-doc-1", contentSha256: "c".repeat(64) }),
}))

function validSelfie(subject = client) {
  return {
    id: "selfie-current",
    deletedAt: null as Date | null,
    verified: true,
    extractionStatus: "done",
    extractionResult: {
      faceDetected: { value: true },
      facesCount: { value: 1 },
      isLive: { value: true },
      quality: { value: "good" },
    },
    extractionError: null,
    validationMismatch: false,
    validationScore: 98,
    biometricMatchScore: 98,
    biometricLiveness: 97,
    biometricVerifiedAt: new Date("2026-07-20T08:20:00.000Z"),
    biometricResult: {
      ok: true,
      verified: true,
      matchScore: 98,
      livenessScore: 97,
      provider: "vlm-face-match-v3",
      faceModel: PASSING_FACE_MODEL_EVIDENCE,
      idPhotoKind: "photograph",
      idPhotoIsRealPhotograph: true,
      idPhotoFaceDetected: true,
      selfieIsRealPhotograph: true,
      samePerson: "same",
      faceMatch: true,
      matchConfidence: 0.98,
      livenessConfidence: 0.97,
      idDocumentId: "id-doc-1",
      idDocumentSha256: "c".repeat(64),
      subjectFingerprint: biometricSubjectFingerprint(subject),
    },
  }
}

function transactionFor(
  application: ReturnType<typeof applicationFixture>,
  kyc: {
    documents?: typeof verifiedCoreDocuments
    selfie?: ReturnType<typeof validSelfie> | null
  } = {},
) {
  const queryRaw = vi.fn()
    .mockResolvedValueOnce([]) // application advisory lock
    .mockResolvedValueOnce([]) // tenant-policy advisory lock
    .mockResolvedValueOnce([{
      id: application.id,
      clientId: application.clientId,
      productId: application.productId,
      bureauReviewGeneration: application.bureauReviewGeneration,
    }])
    .mockResolvedValueOnce([{ id: application.clientId }])
    .mockResolvedValueOnce([{ id: application.productId }])
    .mockResolvedValueOnce([{ id: "config-1" }])
  return {
    $queryRaw: queryRaw,
    creditBureauCheck: { findFirst: vi.fn().mockResolvedValue(bureauCheck) },
    tenantConfig: { findUnique: vi.fn().mockResolvedValue(tenantConfig) },
    // No own loans with this lender (lib/affordability/own-lender-debt.ts).
    loan: { findMany: vi.fn().mockResolvedValue([]) },
    // No product under the product engine: the product's own terms apply.
    productVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    productPricingRule: { findMany: vi.fn().mockResolvedValue([]) },
    applicationPricingInput: { findFirst: vi.fn().mockResolvedValue(null) },
    loanApplication: { findUnique: vi.fn().mockResolvedValue(application), findMany: vi.fn().mockResolvedValue([]) },
    tenant: { findUnique: vi.fn().mockResolvedValue({ name: "Acme Lending" }) },
    clientDocument: {
      findMany: vi.fn().mockResolvedValue(kyc.documents ?? verifiedCoreDocuments),
      findFirst: vi.fn().mockResolvedValue(
        kyc.selfie === undefined ? validSelfie(application.client) : kyc.selfie,
      ),
    },
  }
}

describe("locked affordability approval verification", () => {
  it("approves without biometrics, but still refuses to bind the consumer", async () => {
    // Policy: biometrics gate signing and payout, not origination.
    // The two verifiers must therefore disagree on exactly this input — four
    // verified core documents, no selfie ever captured, cached kycStatus still
    // PENDING because no identity evidence exists yet. If both used the same
    // grade, one of the two halves of the policy would be wrong.
    const application = applicationFixture("UNDER_REVIEW")
    application.client = { ...application.client, kycStatus: "PENDING" }
    const { approval } = buildEvidence()

    const origination = await verifyLockedApprovalCandidate(
      transactionFor(application, { selfie: null }) as never,
      {
        tenantId: "tenant-1",
        applicationId: "application-1",
        expectedApplicationUpdatedAt: applicationUpdatedAt,
        expectedApproval: approval,
        capturedAt,
        calculationStartDate: pasqGeneratedAt,
        capturedById: "officer-1",
        bureauOverrideReason: null,
        expectedPasqDocumentSha256: pasqDocumentSha256,
      },
    )
    expect(origination.ok).toBe(true)

    // Same client, same missing evidence, one step later in the lifecycle.
    const approved = applicationFixture("APPROVED")
    approved.client = { ...approved.client, kycStatus: "PENDING" }
    const payout = await verifyLockedCurrentAffordabilityApproval(
      transactionFor(approved, { selfie: null }) as never,
      { tenantId: "tenant-1", applicationId: "application-1" },
    )
    expect(payout).toEqual({ ok: false, reason: "kyc_changed" })
  })

  it("rebuilds the approval from locked rows and accepts only the exact candidate", async () => {
    const application = applicationFixture("UNDER_REVIEW")
    const tx = transactionFor(application)
    const { approval } = buildEvidence()

    const result = await verifyLockedApprovalCandidate(tx as never, {
      tenantId: "tenant-1",
      applicationId: "application-1",
      expectedApplicationUpdatedAt: applicationUpdatedAt,
      expectedApproval: approval,
      capturedAt,
      calculationStartDate: pasqGeneratedAt,
      capturedById: "officer-1",
      bureauOverrideReason: null,
      expectedPasqDocumentSha256: pasqDocumentSha256,
    })

    expect(result).toEqual({ ok: true, application })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(7)
    expect(tx.$queryRaw).toHaveBeenCalledWith(expect.objectContaining({
      values: ["affordability-client:tenant-1:client-1"],
    }))
    expect(tx.creditBureauCheck.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        applicationId: "application-1",
        reviewGeneration: "review-generation-1",
      }),
    }))
  })

  it("refuses a candidate whose product version in effect prices it over the NCA cap, though the product row does not", async () => {
    // R5,000 over 90 days is short-term: capped at 5% a month. The product row (3%) is under it; the version the loan is written at is not.
    const application = applicationFixture("UNDER_REVIEW")
    const tx = transactionFor(application)
    tx.productVersion.findFirst.mockResolvedValue({
      id: "pv1", productId: "product-1", version: 2, effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      minAmount: 100_000, maxAmount: 800_000, minTermDays: 28, maxTermDays: 180, interestRatePm: 0.06, interestModel: "REDUCING_BALANCE",
      initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.15, initiationFeeMax: 105_000, monthlyServiceFee: 6_900,
      frequency: null, structure: null, graceKind: null, graceInstalments: 0, collateral: [], eligibility: {},
    })
    const { approval } = buildEvidence()
    expect(await verifyLockedApprovalCandidate(tx as never, {
      tenantId: "tenant-1", applicationId: "application-1", expectedApplicationUpdatedAt: applicationUpdatedAt, expectedApproval: approval,
      capturedAt, calculationStartDate: pasqGeneratedAt, capturedById: "officer-1", bureauOverrideReason: null, expectedPasqDocumentSha256: pasqDocumentSha256,
    })).toEqual({ ok: false, reason: "changed" })
  })

  // NCA s.81 requires the affordability assessment to test what the consumer
  // will actually be billed. With credit life ACCEPTED that is the instalment
  // PLUS the premium, and the quotation is no longer there at approval to carry
  // the figure — so approval derives it itself. Every other fixture in this
  // file elects DECLINED, which makes that derivation unobservable: with a zero
  // premium the two pricings are identical and the wiring could be deleted
  // without a single test noticing.
  describe("credit-life premium in the s.81 instalment", () => {
    // The stored disclosure must stay internally consistent: its digest covers
    // the election, so flipping one without the other is a corrupted record
    // that verification rejects for the wrong reason.
    function acceptedCreditLifeTransaction() {
      const application = applicationFixture("UNDER_REVIEW")
      const tx = transactionFor(application)
      const accepted = { ...creditLifeDisclosure, election: "ACCEPTED" as const }
      tx.loanApplication.findUnique.mockResolvedValue({
        ...application,
        creditLifeElection: accepted.election,
        creditLifeDisclosureSha256: createCreditLifeDisclosureSha256(accepted),
      })
      return tx
    }

    function approvalPricedAt(instalmentCents: number, premiumCents: number) {
      const calculation = calculateLoan({
        principal: 500_000,
        termDays: 90,
        ...product,
        initiationFeePayment: "DEFERRED",
      }, pasqGeneratedAt)
      const applicationDebts = normaliseAffordabilityDebts([applicationDebt])
      const clientDebts = normaliseAffordabilityDebts([debt])
      const applicationDebtCents = totalAffordabilityDebt(applicationDebts)
      const clientDebtCents = totalAffordabilityDebt(clientDebts)
      const inputs = {
        monthlyIncomeCents: client.monthlyIncome,
        monthlyExpensesCents: client.monthlyExpenses,
        applicationDebtCents,
        clientDebtCents,
        declaredDebtCents: Math.max(applicationDebtCents, clientDebtCents),
        bureauObligationsCents: 25_000,
        proposedInstalmentCents: instalmentCents,
        creditLifePremiumCents: premiumCents,
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
      return createAffordabilitySnapshot({
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
          override: null,
        }),
        calculation,
        calculationStartDate: pasqGeneratedAt,
        outcome: {
          netDisposableIncomeCents: affordability.ndi,
          ndiAfterLoanCents: affordability.ndi - instalmentCents,
          requiredNdiCents: affordability.requiredNdi,
          isAffordable: !affordability.blocked,
          reason: affordability.reason ?? null,
        },
      })
    }

    const bareCalculation = calculateLoan({
      principal: 500_000,
      termDays: 90,
      ...product,
      initiationFeePayment: "DEFERRED",
    }, pasqGeneratedAt)
    const calculatorEvidence = createAffordabilityCalculatorEvidence(
      bareCalculation,
      pasqGeneratedAt,
    )
    const billedInstalment = createPasqBillingEvidence({
      calculator: calculatorEvidence,
      election: "ACCEPTED",
      monthlyPremiumCents: creditLifeDisclosure.monthlyPremiumCents,
      premiumPeriods: calculateCreditLifePremiumPeriods(calculatorEvidence, 90),
    }).recurringPaymentCents

    function approve(expectedApproval: ReturnType<typeof approvalPricedAt>) {
      return verifyLockedApprovalCandidate(
        acceptedCreditLifeTransaction() as never,
        {
          tenantId: "tenant-1",
          applicationId: "application-1",
          expectedApplicationUpdatedAt: applicationUpdatedAt,
          expectedApproval,
          capturedAt,
          calculationStartDate: pasqGeneratedAt,
          capturedById: "officer-1",
          bureauOverrideReason: null,
          // The quotation is issued after approval now, so there is no document
          // to bind to at this point.
          expectedPasqDocumentSha256: null,
        },
      )
    }

    it("bills an accepted premium on top of the loan instalment", () => {
      // Guards the two cases below against being vacuously equal.
      expect(creditLifeDisclosure.monthlyPremiumCents).toBeGreaterThan(0)
      expect(billedInstalment).toBeGreaterThan(bareCalculation.monthlyInstalment)
    })

    it("accepts an approval priced on the credit-life-inclusive instalment", async () => {
      const result = await approve(approvalPricedAt(
        billedInstalment,
        billedInstalment - bareCalculation.monthlyInstalment,
      ))

      expect(result.ok).toBe(true)
    })

    it("approves a NO-OFFER application — premium 0 is legal, not an error", async () => {
      // The failure shape: DECLINED + premium exactly 0
      // + no-offer disclosure. createPasqBillingEvidence REJECTS a zero
      // premium when `offered` defaults to true, so a call site that omits
      // the flag makes every such application unapprovable at approval time.
      const application = applicationFixture("UNDER_REVIEW")
      const tx = transactionFor(application)
      tx.loanApplication.findUnique.mockResolvedValue({
        ...application,
        creditLifeElection: "DECLINED",
        creditLifeProductId: null,
        creditLifeProductName: null,
        creditLifeInsurerId: null,
        creditLifeInsurerName: null,
        creditLifeMonthlyPremiumCents: 0,
        creditLifeDisclosureVersion: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
        creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256({
          version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
          election: "DECLINED",
          principalCents: 500_000,
          termDays: 90,
        }),
      })

      const result = await verifyLockedApprovalCandidate(tx as never, {
        tenantId: "tenant-1",
        applicationId: "application-1",
        expectedApplicationUpdatedAt: applicationUpdatedAt,
        expectedApproval: approvalPricedAt(bareCalculation.monthlyInstalment, 0),
        capturedAt,
        calculationStartDate: pasqGeneratedAt,
        capturedById: "officer-1",
        bureauOverrideReason: null,
        expectedPasqDocumentSha256: null,
      })

      expect(result.ok).toBe(true)
    })

    it("rejects an approval priced as though no premium were payable", async () => {
      // This is the assertion that dies if the premium ever stops reaching the
      // affordability instalment: without the wiring, approval would recompute
      // the bare instalment and this snapshot would start matching.
      const result = await approve(
        approvalPricedAt(bareCalculation.monthlyInstalment, 0),
      )

      expect(result).toEqual({ ok: false, reason: "changed" })
    })
  })

  it("rejects a financial change that lands after the first approval read", async () => {
    const application = applicationFixture("UNDER_REVIEW")
    application.client = { ...application.client, monthlyExpenses: 810_000 }
    const tx = transactionFor(application)
    const { approval } = buildEvidence()

    const result = await verifyLockedApprovalCandidate(tx as never, {
      tenantId: "tenant-1",
      applicationId: "application-1",
      expectedApplicationUpdatedAt: applicationUpdatedAt,
      expectedApproval: approval,
      capturedAt,
      calculationStartDate: pasqGeneratedAt,
      capturedById: "officer-1",
      bureauOverrideReason: null,
      expectedPasqDocumentSha256: pasqDocumentSha256,
    })

    expect(result).toEqual({ ok: false, reason: "expense_evidence_invalid" })
  })

  it("rejects agreement or signing progression when locked inputs no longer match approval", async () => {
    const application = applicationFixture("APPROVED")
    application.client = { ...application.client, monthlyExpenses: 810_000 }
    const tx = transactionFor(application)

    const result = await verifyLockedCurrentAffordabilityApproval(tx as never, {
      tenantId: "tenant-1",
      applicationId: "application-1",
    })

    expect(result).toEqual({ ok: false, reason: "expense_evidence_invalid" })
  })

  it("accepts a migrated override decision that retains its exact successful bureau check", async () => {
    const application = applicationFixture(
      "APPROVED",
      "Senior exception approved against the sealed bureau result",
    )
    const tx = transactionFor(application)

    const result = await verifyLockedCurrentAffordabilityApproval(tx as never, {
      tenantId: "tenant-1",
      applicationId: "application-1",
    })

    expect(result).toEqual(expect.objectContaining({ ok: true }))
    if (result.ok) {
      expect(result.approval.bureauEvidence).toEqual(expect.objectContaining({
        mode: "OVERRIDE",
        check: expect.objectContaining({ id: "bureau-1" }),
      }))
    }
    expect(tx.creditBureauCheck.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        applicationId: "application-1",
        reviewGeneration: "review-generation-1",
      }),
    }))
  })

  it("rejects agreement, signing, and payout progression after current KYC is revoked", async () => {
    const application = applicationFixture("APPROVED")
    application.client = { ...application.client, kycStatus: "FAILED" }
    const tx = transactionFor(application)

    const result = await verifyLockedCurrentAffordabilityApproval(tx as never, {
      tenantId: "tenant-1",
      applicationId: "application-1",
    })

    expect(result).toEqual({ ok: false, reason: "kyc_changed" })
  })

  it.each([
    ["a required core document is no longer verified", {
      documents: verifiedCoreDocuments.filter(({ docType }) => docType !== "BANK_STATEMENT"),
    }],
    ["the latest selfie was deleted", {
      selfie: { ...validSelfie(), deletedAt: new Date("2026-07-20T08:30:00.000Z") },
    }],
    ["the latest selfie fails liveness", {
      selfie: { ...validSelfie(), biometricLiveness: 0 },
    }],
    ["the latest selfie belongs to an earlier identity", {
      selfie: {
        ...validSelfie(),
        biometricResult: {
          ...validSelfie().biometricResult,
          subjectFingerprint: biometricSubjectFingerprint({
            ...client,
            idNumber: "9101015009086",
          }),
        },
      },
    }],
    ["the provider evidence is simulated", {
      selfie: {
        ...validSelfie(),
        biometricResult: { ...validSelfie().biometricResult, simulated: true },
      },
    }],
  ])("rejects agreement and signing when %s", async (_label, kyc) => {
    const application = applicationFixture("APPROVED")
    const tx = transactionFor(application, kyc)

    await expect(verifyLockedCurrentAffordabilityApproval(tx as never, {
      tenantId: "tenant-1",
      applicationId: "application-1",
    })).resolves.toEqual({ ok: false, reason: "kyc_changed" })
  })

  it.each([
    [null, "null"],
    ["corrupt", "a string"],
    [{ monthlyInstalment: 250_000, balance: 1_000_000 }, "an object"],
  ])("fails closed when persisted debt evidence is %s (%s)", async (value, _description) => {
    const application = applicationFixture("APPROVED")
    application.existingDebtObligations = value as never
    const tx = transactionFor(application)

    const result = await verifyLockedCurrentAffordabilityApproval(tx as never, {
      tenantId: "tenant-1",
      applicationId: "application-1",
    })

    expect(result).toEqual({ ok: false, reason: "debt_evidence_invalid" })
  })

  it("rejects a bureau check captured for a different subject", async () => {
    const application = applicationFixture("UNDER_REVIEW")
    const tx = transactionFor(application)
    tx.creditBureauCheck.findFirst.mockResolvedValue({
      ...bureauCheck,
      clientId: "client-2",
    })
    const { approval } = buildEvidence()

    const result = await verifyLockedApprovalCandidate(tx as never, {
      tenantId: "tenant-1",
      applicationId: "application-1",
      expectedApplicationUpdatedAt: applicationUpdatedAt,
      expectedApproval: approval,
      capturedAt,
      calculationStartDate: pasqGeneratedAt,
      capturedById: "officer-1",
      bureauOverrideReason: null,
      expectedPasqDocumentSha256: pasqDocumentSha256,
    })

    expect(result).toEqual({ ok: false, reason: "bureau_subject_changed" })
  })

  it("rejects candidate approval when the acknowledged PASQ hash changed", async () => {
    const application = applicationFixture("UNDER_REVIEW")
    application.pasqAcknowledgedSha256 = "a".repeat(64)
    const tx = transactionFor(application)
    const { approval } = buildEvidence()

    const result = await verifyLockedApprovalCandidate(tx as never, {
      tenantId: "tenant-1",
      applicationId: "application-1",
      expectedApplicationUpdatedAt: applicationUpdatedAt,
      expectedApproval: approval,
      capturedAt,
      calculationStartDate: pasqGeneratedAt,
      capturedById: "officer-1",
      bureauOverrideReason: null,
      expectedPasqDocumentSha256: pasqDocumentSha256,
    })

    expect(result).toEqual({ ok: false, reason: "compliance_changed" })
  })

  it("rejects downstream progression when approval is not bound to the PASQ hash", async () => {
    const application = applicationFixture("APPROVED")
    application.approvedPasqDocumentSha256 = null
    const tx = transactionFor(application)

    const result = await verifyLockedCurrentAffordabilityApproval(tx as never, {
      tenantId: "tenant-1",
      applicationId: "application-1",
    })

    expect(result).toEqual({ ok: false, reason: "pasq_changed" })
  })
})

// A product's pricing terms are what the consumer was quoted under NCA s.92 and
// agreed to. Editing the LoanProduct row afterwards is ordinary maintenance for
// FUTURE applications — it must never reach backwards and invalidate a deal that
// has already been priced, quoted and approved. Flipping the Personal Loan
// product REDUCING_BALANCE -> FLAT must not silently reprice an approved
// R10,000 loan from 3 instalments totalling R11,892.91 to a single R12,187.00
// bullet payment, nor block its agreement from being generated.
describe("product pricing terms are frozen at approval", () => {
  // The repriced product below is deliberately a WORSE deal on a DIFFERENT
  // interest model, so if the verifier ever re-derives from the live row again
  // the pricing fingerprint cannot coincidentally still match.
  function repricedAfterApproval(
    application: ReturnType<typeof applicationFixture>,
  ) {
    return {
      ...application,
      product: {
        ...application.product,
        interestModel: "FLAT" as "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL",
        interestRatePm: 0.05,
        monthlyServiceFee: 9_900,
      },
    }
  }

  it("generates an agreement after the product is repriced post-approval", () => {
    const application = applicationFixture("APPROVED")

    const approvedCalculation = calculateLoan({
      principal: 500_000,
      termDays: 90,
      ...product,
      initiationFeePayment: "DEFERRED",
    }, pasqGeneratedAt)

    const result = verifyCurrentAffordabilityApproval({
      application: repricedAfterApproval(application),
      bureauCheck,
      tenantConfig,
      requirePasqAcknowledgement: false,
    })

    expect(result.ok).toBe(true)
    // Passing the gate is not enough: the schedule handed back must be the
    // APPROVED one. Asserting only `ok` would stay green on an implementation
    // that admitted the loan and then priced it off the repriced product.
    expect(result.ok && result.calculation).toEqual(approvedCalculation)
  })

  it("re-checks an own-lender loan on the entry the approval recorded, not a re-read", () => {
    // Her loan with this lender was counted at approval. Paying it down (or
    // settling it) before payout changes the live loan, not the decision.
    const own = {
      lenderNames: ["Acme Lending"],
      loans: [{ id: "own-1", reference: "LN-OWN-1", status: "ACTIVE", instalmentCents: 30_000, outstandingPrincipal: 900_000, daysInArrears: 0, arrearsAmount: 0 }],
    }
    const application = applicationFixture("APPROVED", null, own)
    expect(application.affordabilityResult.approval?.inputs.declaredDebtCents).toBe(50_000 + 30_000)

    const result = verifyCurrentAffordabilityApproval({
      application,
      bureauCheck,
      tenantConfig,
      requirePasqAcknowledgement: false,
    })

    expect(result).toMatchObject({ ok: true })
  })

  it("fails signing and payout closed when the client owes this lender more than the approval recorded", async () => {
    const application = repricedAfterApproval(applicationFixture("APPROVED"))
    const tx = transactionFor(application)
    // Another loan of the client was paid out after this approval.
    tx.loan.findMany.mockResolvedValue([{
      id: "loan-later", clientId: "client-1", reference: "LN-LATER", status: "ACTIVE", outstandingPrincipal: 300_000,
      daysInArrears: 0, arrearsAmount: 0, repaymentSchedule: [{ totalDue: 110_000 }, { totalDue: 105_000 }],
    }])
    const result = await verifyLockedCurrentAffordabilityApproval(tx as never, { tenantId: "tenant-1", applicationId: "application-1" })
    expect(result).toEqual({ ok: false, reason: "changed" })
  })

  it("re-checks the repeat short-term rate at payout on the rate the approval froze", async () => {
    // R5,000 over 90 days is short-term; an earlier short-term loan this year
    // allows at most 3% a month. Approved at 3%; the product now says 5%.
    const application = repricedAfterApproval(applicationFixture("APPROVED"))
    const tx = transactionFor(application)
    tx.loan.findMany.mockImplementation(async (args: { where: { status?: unknown } }) =>
      "status" in args.where && (args.where.status as { not?: string }).not === "CANCELLED"
        ? [{ startDate: new Date("2026-02-01T10:00:00Z"), maturityDate: new Date("2026-03-01T10:00:00Z") }]
        : [])
    expect((await verifyLockedCurrentAffordabilityApproval(tx as never, { tenantId: "tenant-1", applicationId: "application-1" })).ok).toBe(true)
    expect(tx.loan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { not: "CANCELLED" }, applicationId: { not: "application-1" } }),
    }))
  })

  it("permits signing and payout after the product is repriced post-approval", async () => {
    const application = repricedAfterApproval(applicationFixture("APPROVED"))
    const tx = transactionFor(application)

    const result = await verifyLockedCurrentAffordabilityApproval(tx as never, {
      tenantId: "tenant-1",
      applicationId: "application-1",
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.calculation.monthlyInstalment).toBe(
      calculateLoan({
        principal: 500_000,
        termDays: 90,
        ...product,
        initiationFeePayment: "DEFERRED",
      }, pasqGeneratedAt).monthlyInstalment,
    )
  })

  // The freeze must not be allowed to swallow the check it sits next to. Once
  // pricing is read from the approval snapshot, comparing that snapshot against
  // itself would pass unconditionally; what still has to hold is that the
  // quotation the CONSUMER acknowledged was priced on the same frozen terms.
  it("still refuses when the acknowledged PASQ was priced off different terms", () => {
    const application = applicationFixture("APPROVED")
    const otherTerms = { ...product, interestRatePm: 0.05 }
    const mispricedPasq = createPasqEvidence({
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
          ...otherTerms,
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

    const result = verifyCurrentAffordabilityApproval({
      application: {
        ...application,
        pasqEvidence: mispricedPasq,
        pasqEvidenceSha256: mispricedPasq.evidenceSha256,
      },
      bureauCheck,
      tenantConfig,
      requirePasqAcknowledgement: false,
    })

    expect(result).toEqual({ ok: false, reason: "pasq_changed" })
  })
})

describe("simulated bureau evidence at payout", () => {
  afterEach(() => vi.unstubAllEnvs())
  const simulatedCheck = { ...bureauCheck, obligations: { ...bureauCheck.obligations, simulated: true } }
  const verify = (check: typeof bureauCheck) =>
    verifyCurrentAffordabilityApproval({
      application: applicationFixture("APPROVED"),
      bureauCheck: check,
      tenantConfig,
    })

  it("refuses a simulated check where this deployment forbids Experian simulation", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(verify(simulatedCheck)).toEqual({ ok: false, reason: "bureau_simulated" })
  })

  it("refuses payout end to end: a simulated row on an APPROVED application stops disbursement evidence", () => {
    vi.stubEnv("NODE_ENV", "production")
    const evidence = (check: typeof bureauCheck) =>
      verifyCurrentDisbursementEvidence({
        application: disbursementApplicationFixture() as never,
        bureauCheck: check,
        tenantConfig,
        at: new Date("2026-07-21T09:00:00.000Z"),
      })

    expect(evidence(simulatedCheck)).toEqual({ ok: false, reason: "bureau_simulated" })
    expect(evidence(bureauCheck)).not.toEqual({ ok: false, reason: "bureau_simulated" })
  })

  it("does not raise bureau_simulated for a genuine check on a deployed build", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(verify(bureauCheck)).toMatchObject({ ok: true })
  })

  it("does not refuse for simulation where simulation is permitted", () => {
    vi.stubEnv("NODE_ENV", "test")
    expect(verify(simulatedCheck)).not.toEqual({ ok: false, reason: "bureau_simulated" })
  })
})
