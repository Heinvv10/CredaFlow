import { CREDIT_LIFE_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { describe, expect, it } from "vitest"
import { calculateLoan } from "@/lib/loan-calculator"
import { createAffordabilityCalculatorEvidence } from "@/lib/affordability/snapshot"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import {
  createPasqEvidence,
  pasqEvidenceIsIntact,
  pasqEvidenceSha256,
  verifyStoredPasqBinding,
} from "./pasq"

const generatedAt = new Date("2026-07-23T08:00:00.000Z")

function fixture(election: "ACCEPTED" | "DECLINED" = "ACCEPTED") {
  const calculator = createAffordabilityCalculatorEvidence(calculateLoan({
    principal: 500_000,
    termDays: 60,
    interestRatePm: 0.05,
    interestModel: "REDUCING_BALANCE",
    initiationFeeModel: "FLAT_PCT",
    initiationFeePct: 0.1,
    initiationFeeMax: 105_000,
    monthlyServiceFee: 6_900,
    initiationFeePayment: "DEFERRED",
    productType: "PERSONAL",
  }, generatedAt), generatedAt)
  const disclosure = {
    version: "credit-life-election-v1" as const,
    election,
    principalCents: 500_000,
    termDays: 60,
    monthlyPremiumCents: 2_250,
    productId: "cl-product-1",
    productName: "Credit Life",
    insurerId: "insurer-1",
    insurerName: "Example Insurer",
  }
  return createPasqEvidence({
    tenantId: "tenant-1",
    applicationId: "app-1",
    clientId: "client-1",
    productId: "loan-product-1",
    termDays: 60,
    generatedAt,
    calculator,
    creditLife: {
      election,
      productId: disclosure.productId,
      productName: disclosure.productName,
      insurerId: disclosure.insurerId,
      insurerName: disclosure.insurerName,
      monthlyPremiumCents: disclosure.monthlyPremiumCents,
      disclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
      disclosureSha256: createCreditLifeDisclosureSha256(disclosure),
    },
  })
}

describe("versioned PASQ evidence", () => {
  it("includes every elected premium period in total cost of credit", () => {
    const evidence = fixture()
    expect(evidence.creditLife.premiumPeriods).toBe(2)
    expect(evidence.creditLife.totalPremiumCents).toBe(4_500)
    expect(evidence.billing.schedule).toHaveLength(2)
    expect(evidence.billing.schedule.every((row) =>
      row.creditLifePremiumDueCents === 2_250
      && row.feesDueCents === row.baseFeesDueCents + 2_250
      && row.totalDueCents ===
        row.principalDueCents + row.interestDueCents + row.feesDueCents
    )).toBe(true)
    expect(evidence.billing.totalRepayableCents).toBe(
      evidence.calculator.totalRepayableCents + 4_500,
    )
    expect(evidence.totalCostOfCreditCents).toBe(
      evidence.calculator.principalCents
      + evidence.calculator.totalInterestCents
      + evidence.calculator.serviceFeesCents
      + evidence.calculator.initiationFeeCents
      + 4_500,
    )
    expect(pasqEvidenceIsIntact(evidence)).toBe(true)
  })

  it("records a declined election without adding a premium", () => {
    const evidence = fixture("DECLINED")
    expect(evidence.creditLife.totalPremiumCents).toBe(0)
    expect(pasqEvidenceIsIntact(evidence)).toBe(true)
  })

  it("binds every monthly premium to a multi-month bullet repayment", () => {
    const calculator = createAffordabilityCalculatorEvidence(calculateLoan({
      principal: 500_000,
      termDays: 60,
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
      initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0.1,
      initiationFeeMax: 105_000,
      monthlyServiceFee: 6_900,
      initiationFeePayment: "DEFERRED",
      productType: "MICRO",
    }, generatedAt), generatedAt)
    const disclosure = {
      version: "credit-life-election-v1" as const,
      election: "ACCEPTED" as const,
      principalCents: 500_000,
      termDays: 60,
      monthlyPremiumCents: 2_250,
      productId: "cl-product-1",
      productName: "Credit Life",
      insurerId: "insurer-1",
      insurerName: "Example Insurer",
    }
    expect(calculator.schedule).toHaveLength(1)
    const evidence = createPasqEvidence({
      tenantId: "tenant-1",
      applicationId: "app-bullet",
      clientId: "client-1",
      productId: "loan-product-1",
      termDays: 60,
      generatedAt,
      calculator,
      creditLife: {
        election: disclosure.election,
        productId: disclosure.productId,
        productName: disclosure.productName,
        insurerId: disclosure.insurerId,
        insurerName: disclosure.insurerName,
        monthlyPremiumCents: disclosure.monthlyPremiumCents,
        disclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
        disclosureSha256: createCreditLifeDisclosureSha256(disclosure),
      },
    })
    expect(evidence.creditLife.premiumPeriods).toBe(2)
    expect(evidence.billing.schedule[0].creditLifePremiumDueCents).toBe(4_500)
    expect(evidence.billing.totalRepayableCents).toBe(
      evidence.calculator.totalRepayableCents + 4_500,
    )
    expect(evidence.billing.recurringPaymentCents).toBe(
      evidence.calculator.recurringInstalmentCents + 4_500,
    )
    expect(pasqEvidenceIsIntact(evidence)).toBe(true)
  })

  it("detects premium, calculator, disclosure, and evidence-hash mutation", () => {
    const evidence = fixture()
    expect(pasqEvidenceIsIntact({
      ...evidence,
      tenantId: "tenant-2",
    })).toBe(false)
    expect(pasqEvidenceIsIntact({
      ...evidence,
      creditLife: { ...evidence.creditLife, totalPremiumCents: 1 },
    })).toBe(false)
    expect(pasqEvidenceIsIntact({
      ...evidence,
      calculator: { ...evidence.calculator, totalInterestCents: 1 },
    })).toBe(false)
    expect(pasqEvidenceIsIntact({
      ...evidence,
      creditLife: { ...evidence.creditLife, disclosureSha256: "a".repeat(64) },
    })).toBe(false)
    expect(pasqEvidenceIsIntact({
      ...evidence,
      billing: {
        ...evidence.billing,
        totalRepayableCents: evidence.billing.totalRepayableCents - 1,
      },
    })).toBe(false)
    expect(pasqEvidenceIsIntact({ ...evidence, evidenceSha256: "b".repeat(64) })).toBe(false)
  })

  it("binds customer acknowledgement and approval to the exact document hash", () => {
    const evidence = fixture()
    const documentSha256 = "d".repeat(64)
    const stored = {
      clientId: evidence.clientId,
      pasqVersion: evidence.version,
      pasqGeneratedAt: new Date(evidence.generatedAt),
      pasqDocumentId: "pasq-doc-1",
      pasqDocumentSha256: documentSha256,
      pasqEvidence: evidence,
      pasqEvidenceSha256: evidence.evidenceSha256,
      pasqAcknowledgedAt: new Date("2026-07-23T08:05:00.000Z"),
      pasqAcknowledgedBy: evidence.clientId,
      pasqAcknowledgedSha256: documentSha256,
      approvedPasqDocumentSha256: documentSha256,
    }
    const expected = {
      tenantId: evidence.tenantId,
      applicationId: evidence.applicationId,
      clientId: evidence.clientId,
      productId: evidence.productId,
      calculatorPricingFingerprint: evidence.calculator.pricingFingerprint,
      creditLifeDisclosureSha256: evidence.creditLife.disclosureSha256,
      requireApprovalBinding: true,
    }
    expect(verifyStoredPasqBinding(stored, expected).ok).toBe(true)
    expect(verifyStoredPasqBinding({ ...stored, pasqAcknowledgedBy: "staff-user" }, expected))
      .toEqual({ ok: false, reason: "not_client_acknowledged" })
    expect(verifyStoredPasqBinding({ ...stored, pasqAcknowledgedSha256: "a".repeat(64) }, expected))
      .toEqual({ ok: false, reason: "acknowledgement_changed" })
    expect(verifyStoredPasqBinding({ ...stored, approvedPasqDocumentSha256: null }, expected))
      .toEqual({ ok: false, reason: "approval_binding_missing" })
  })

  it("allows an intact issued PASQ to prepare the agreement before the signing ceremony", () => {
    const evidence = fixture()
    const documentSha256 = "d".repeat(64)
    const stored = {
      clientId: evidence.clientId,
      pasqVersion: evidence.version,
      pasqGeneratedAt: new Date(evidence.generatedAt),
      pasqDocumentId: "pasq-doc-1",
      pasqDocumentSha256: documentSha256,
      pasqEvidence: evidence,
      pasqEvidenceSha256: evidence.evidenceSha256,
      pasqAcknowledgedAt: null,
      pasqAcknowledgedBy: null,
      pasqAcknowledgedSha256: null,
      approvedPasqDocumentSha256: null,
    }
    const expected = {
      tenantId: evidence.tenantId,
      applicationId: evidence.applicationId,
      clientId: evidence.clientId,
      productId: evidence.productId,
      calculatorPricingFingerprint: evidence.calculator.pricingFingerprint,
      creditLifeDisclosureSha256: evidence.creditLife.disclosureSha256,
      requireAcknowledgement: false,
    }

    expect(verifyStoredPasqBinding(stored, expected).ok).toBe(true)
    expect(verifyStoredPasqBinding(stored, {
      ...expected,
      requireAcknowledgement: true,
    })).toEqual({ ok: false, reason: "not_client_acknowledged" })
    expect(verifyStoredPasqBinding({
      ...stored,
      pasqAcknowledgedAt: new Date("2026-07-23T08:05:00.000Z"),
    }, expected)).toEqual({ ok: false, reason: "not_client_acknowledged" })
  })
})

describe("PASQ evidence survives a jsonb key-order round trip", () => {
  /** Reproduces jsonb's key ordering: by key length, then bytewise. */
  function reorderLikeJsonb<T>(value: T): T {
    if (Array.isArray(value)) {
      return value.map(reorderLikeJsonb) as unknown as T
    }
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      const record = value as Record<string, unknown>
      const sorted = Object.keys(record).sort((a, b) =>
        a.length !== b.length ? a.length - b.length : (a < b ? -1 : a > b ? 1 : 0)
      )
      const out: Record<string, unknown> = {}
      for (const key of sorted) out[key] = reorderLikeJsonb(record[key])
      return out as unknown as T
    }
    return value
  }

  it("accepts evidence whose keys came back in jsonb order", () => {
    const evidence = fixture()
    const roundTripped = reorderLikeJsonb(evidence)

    // Guard the test itself: the round trip must actually have moved keys,
    // otherwise this passes vacuously.
    expect(Object.keys(roundTripped.billing).join(","))
      .not.toBe(Object.keys(evidence.billing).join(","))
    expect(pasqEvidenceIsIntact(roundTripped)).toBe(true)
  })

  /**
   * Re-seal the envelope hash after tampering.
   *
   * Without this the `evidenceSha256` clause rejects the row first and the
   * billing comparison is never reached — so the test passes even when the
   * billing comparison is deleted outright, guarding nothing about the line
   * this change touches. Re-sealing makes the billing comparison the only
   * thing that can reject.
   */
  function reseal<T extends { evidenceSha256: string }>(evidence: T): T {
    const { evidenceSha256: _stale, ...withoutHash } = evidence
    return {
      ...withoutHash,
      evidenceSha256: pasqEvidenceSha256(withoutHash as never),
    } as unknown as T
  }

  it("still rejects a changed billing VALUE, envelope hash re-sealed", () => {
    const evidence = reorderLikeJsonb(fixture())
    const tampered = reseal({
      ...evidence,
      billing: {
        ...evidence.billing,
        recurringPaymentCents: evidence.billing.recurringPaymentCents + 1,
      },
    })

    expect(pasqEvidenceIsIntact(tampered)).toBe(false)
  })

  it("still rejects a changed billing schedule row, envelope hash re-sealed", () => {
    const evidence = reorderLikeJsonb(fixture())
    const tampered = reseal({
      ...evidence,
      billing: {
        ...evidence.billing,
        schedule: evidence.billing.schedule.map((row, index) =>
          index === 0 ? { ...row, totalDueCents: row.totalDueCents + 1 } : row
        ),
      },
    })

    expect(pasqEvidenceIsIntact(tampered)).toBe(false)
  })
})
