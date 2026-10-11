import { CREDIT_LIFE_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { describe, expect, it } from "vitest"
import {
  DebitMandateEvidenceError,
  debitMandatePaymentTerms,
  requireDebitMandateBankDetails,
} from "./debit-mandate"
import { createDebitMandateTestEvidence } from "./__fixtures__/debit-mandate"
import { createPasqEvidence } from "@/lib/compliance/pasq"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { createAffordabilityContractEvidence } from "@/lib/affordability/snapshot"

type Evidence = ReturnType<typeof createDebitMandateTestEvidence>

function paymentTerms(
  evidence: Evidence,
  overrides: Partial<Parameters<typeof debitMandatePaymentTerms>[0]> = {},
) {
  return debitMandatePaymentTerms({
    schedule: evidence.schedule,
    principal: evidence.calculation.principal,
    totalInterest: evidence.calculation.totalInterest,
    totalRepayable: evidence.calculation.totalRepayable,
    initiationFee: evidence.calculation.initiationFee,
    initiationFeePayment: evidence.initiationFeePayment,
    startDate: evidence.startDate,
    maturityDate: evidence.maturityDate,
    affordabilityResult: evidence.affordabilityResult,
    ...overrides,
  })
}

describe("debitMandatePaymentTerms", () => {
  it("separates a deferred-fee first debit from the recurring instalment", () => {
    const evidence = createDebitMandateTestEvidence()
    const terms = paymentTerms(evidence)

    expect(terms).toEqual({
      paymentFrequency: "MONTHLY",
      recurringDebitAmount: evidence.calculation.schedule[1].totalDue,
      firstDebitAmount: evidence.calculation.schedule[0].totalDue,
      firstDebitDate: evidence.calculation.schedule[0].dueDate,
      firstDebitInitiationFee: evidence.calculation.initiationFee,
    })
  })

  it("uses the sole signed scheduled debit for a bullet loan", () => {
    const evidence = createDebitMandateTestEvidence({
      termDays: 30,
      interestRatePm: 0.03,
      interestModel: "DAILY_ACCRUAL",
    })

    expect(paymentTerms(evidence)).toEqual({
      paymentFrequency: "ONCE_OFF",
      recurringDebitAmount: null,
      firstDebitAmount: evidence.calculation.schedule[0].totalDue,
      firstDebitDate: evidence.maturityDate,
      firstDebitInitiationFee: evidence.calculation.initiationFee,
    })
  })

  it("uses the premium-inclusive PASQ v3 ledger after same-day funding", () => {
    const evidence = createDebitMandateTestEvidence()
    const creditLife = {
      version: "credit-life-election-v1" as const,
      election: "ACCEPTED" as const,
      principalCents: evidence.calculation.principal,
      termDays: 90,
      monthlyPremiumCents: 2_250,
      productId: "credit-life-1",
      productName: "Synthetic Credit Life",
      insurerId: "insurer-1",
      insurerName: "Synthetic Insurer",
    }
    const pasqEvidence = createPasqEvidence({
      tenantId: "tenant-1",
      applicationId: "application-1",
      clientId: "client-1",
      productId: "debit-mandate-test-product",
      termDays: 90,
      generatedAt: evidence.startDate,
      calculator: evidence.affordabilityResult.approval.calculator,
      creditLife: {
        election: creditLife.election,
        productId: creditLife.productId,
        productName: creditLife.productName,
        insurerId: creditLife.insurerId,
        insurerName: creditLife.insurerName,
        monthlyPremiumCents: creditLife.monthlyPremiumCents,
        disclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
        disclosureSha256: createCreditLifeDisclosureSha256(creditLife),
      },
    })
    const fundingOffsetMs = 12 * 60 * 60 * 1_000
    const agreementOffsetMs = 6 * 60 * 60 * 1_000
    const agreementGeneratedAt = new Date(
      evidence.startDate.getTime() + agreementOffsetMs,
    )
    const contract = createAffordabilityContractEvidence(
      evidence.affordabilityResult.approval,
      agreementGeneratedAt,
      {
        documentSha256:
          evidence.affordabilityResult.contract.acceptedPasqDocumentSha256,
        calculator: evidence.affordabilityResult.approval.calculator,
      },
    )
    const schedule = pasqEvidence.billing.schedule.map((item) => ({
      installmentNo: item.installmentNo,
      dueDate: new Date(new Date(item.dueDate).getTime() + agreementOffsetMs),
      principalDue: item.principalDueCents,
      interestDue: item.interestDueCents,
      feesDue: item.feesDueCents,
      totalDue: item.totalDueCents,
    }))
    const maturityDate = schedule.at(-1)?.dueDate
    expect(maturityDate).toBeDefined()

    const terms = paymentTerms(evidence, {
      schedule,
      totalRepayable: pasqEvidence.billing.totalRepayableCents,
      startDate: new Date(evidence.startDate.getTime() + fundingOffsetMs),
      maturityDate: maturityDate!,
      pasqEvidence,
      affordabilityResult: {
        ...evidence.affordabilityResult,
        contract,
      },
    })

    expect(terms.firstDebitAmount).toBe(
      pasqEvidence.billing.schedule[0].totalDueCents,
    )
    expect(terms.recurringDebitAmount).toBe(
      pasqEvidence.billing.schedule[1].totalDueCents,
    )
  })

  it("rejects PASQ v3 funding that moves the signed schedule to another day", () => {
    const evidence = createDebitMandateTestEvidence()
    const creditLife = {
      version: "credit-life-election-v1" as const,
      election: "DECLINED" as const,
      principalCents: evidence.calculation.principal,
      termDays: 90,
      monthlyPremiumCents: 2_250,
      productId: "credit-life-1",
      productName: "Synthetic Credit Life",
      insurerId: "insurer-1",
      insurerName: "Synthetic Insurer",
    }
    const pasqEvidence = createPasqEvidence({
      tenantId: "tenant-1",
      applicationId: "application-1",
      clientId: "client-1",
      productId: "debit-mandate-test-product",
      termDays: 90,
      generatedAt: evidence.startDate,
      calculator: evidence.affordabilityResult.approval.calculator,
      creditLife: {
        election: creditLife.election,
        productId: creditLife.productId,
        productName: creditLife.productName,
        insurerId: creditLife.insurerId,
        insurerName: creditLife.insurerName,
        monthlyPremiumCents: creditLife.monthlyPremiumCents,
        disclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
        disclosureSha256: createCreditLifeDisclosureSha256(creditLife),
      },
    })

    expect(() => paymentTerms(evidence, {
      pasqEvidence,
      startDate: new Date(evidence.startDate.getTime() + 86_400_000),
    })).toThrow(/immutable signed repayment evidence/i)
  })

  it("rejects a rebalanced truncated schedule even when it foots to every loan total", () => {
    const evidence = createDebitMandateTestEvidence()
    const rebalancedBullet = [{
      installmentNo: 1,
      dueDate: evidence.maturityDate,
      principalDue: evidence.calculation.principal,
      interestDue: evidence.calculation.totalInterest,
      feesDue: evidence.calculation.serviceFees + evidence.calculation.initiationFee,
      totalDue: evidence.calculation.totalRepayable,
    }]

    expect(() => paymentTerms(evidence, { schedule: rebalancedBullet }))
      .toThrow(/immutable signed repayment evidence/i)
  })

  it("rejects a 20-day pseudo-monthly sequence that differs from the signed dates", () => {
    const evidence = createDebitMandateTestEvidence()
    const shifted = evidence.schedule.map((item, index) => ({
      ...item,
      dueDate: new Date(evidence.schedule[0].dueDate.getTime() + index * 20 * 86_400_000),
    }))

    expect(() => paymentTerms(evidence, { schedule: shifted }))
      .toThrow(/persisted repayment schedule differs/i)
  })

  it("rejects a bullet that hides an upfront initiation fee in the debit", () => {
    const evidence = createDebitMandateTestEvidence({
      termDays: 30,
      interestModel: "DAILY_ACCRUAL",
      initiationFeePayment: "UPFRONT",
    })
    const row = evidence.schedule[0]
    const wrongTotal = row.totalDue + evidence.calculation.initiationFee
    const wrongSchedule = [{
      ...row,
      feesDue: row.feesDue + evidence.calculation.initiationFee,
      totalDue: wrongTotal,
    }]

    expect(() => paymentTerms(evidence, {
      schedule: wrongSchedule,
      totalRepayable: wrongTotal,
    })).toThrow(/immutable signed repayment evidence/i)
  })

  it("rejects a different initiation-fee election from the signed approval", () => {
    const evidence = createDebitMandateTestEvidence()

    expect(() => paymentTerms(evidence, { initiationFeePayment: "UPFRONT" }))
      .toThrow(/immutable signed repayment evidence/i)
  })

  it("rejects missing, corrupt, or date-mismatched signed evidence", () => {
    const evidence = createDebitMandateTestEvidence()
    expect(() => paymentTerms(evidence, { affordabilityResult: null }))
      .toThrow(/immutable signed repayment evidence/i)
    expect(() => paymentTerms(evidence, {
      maturityDate: new Date(evidence.maturityDate.getTime() - 86_400_000),
    })).toThrow(/do not match the immutable signed repayment evidence/i)
  })

  it("refuses an absent schedule instead of printing a zero authority", () => {
    const evidence = createDebitMandateTestEvidence()
    expect(() => paymentTerms(evidence, { schedule: [] }))
      .toThrow(DebitMandateEvidenceError)
  })
})

describe("requireDebitMandateBankDetails", () => {
  const valid = {
    firstName: "Synthetic",
    lastName: "Customer",
    bankName: "Test Bank",
    bankBranchCode: "250655",
    bankAccountNumber: "1234567890",
    accountType: "CHEQUE",
  }

  it("returns complete trimmed on-file banking details", () => {
    expect(requireDebitMandateBankDetails({
      ...valid,
      bankName: " Test Bank ",
      bankBranchCode: " 250655 ",
      bankAccountNumber: " 1234567890 ",
    })).toEqual({
      bankName: "Test Bank",
      branchCode: "250655",
      accountNumber: "1234567890",
      accountType: "CHEQUE",
    })
  })

  it("REJECTS a transmission account", () => {
    // Accepting it here let a consumer sign a mandate the database would
    // refuse at payout: the guard allow-lists ('CHEQUE','SAVINGS') and the DB
    // canonicaliser has no transmission branch, so disbursement raised 23514
    // and surfaced as a bare 500 with no staff-side remedy. Zero clients ever
    // chose it, so the type was removed rather than the guards widened.
    // Cast: the union no longer admits it, which is the point.
    expect(() => requireDebitMandateBankDetails(
      { ...valid, accountType: "TRANSMISSION" as unknown as "CHEQUE" },
    )).toThrow(/Complete on-file banking details/)
  })

  it("still rejects an account type outside the enum", () => {
    expect(() => requireDebitMandateBankDetails({ ...valid, accountType: "BITCOIN" }))
      .toThrow(/complete on-file banking details/i)
  })

  it("fails closed when any mandate banking field is missing", () => {
    expect(() => requireDebitMandateBankDetails({
      ...valid,
      bankBranchCode: null,
    })).toThrow(/complete on-file banking details/i)
  })

  it.each([
    [{ bankName: "TODO" }, "placeholder bank"],
    [{ bankName: "Other" }, "unresolved bank choice"],
    [{ bankBranchCode: "000000" }, "repeated branch"],
    [{ bankAccountNumber: "1111111111" }, "repeated account"],
    [{ bankAccountNumber: "not-digits" }, "malformed account"],
    [{ firstName: "A".repeat(121) }, "overflowing account holder"],
  ])("rejects %s (%s)", (invalid, _label) => {
    expect(() => requireDebitMandateBankDetails({ ...valid, ...invalid }))
      .toThrow(/complete on-file banking details/i)
  })
})
