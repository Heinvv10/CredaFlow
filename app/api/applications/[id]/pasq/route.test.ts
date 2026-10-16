import { CREDIT_LIFE_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { calculateLoan } from "@/lib/loan-calculator"
import {
  APPROVAL_AFFORDABILITY_POLICY_VERSION,
  createAffordabilityCalculatorEvidence,
  createAffordabilityExpenseEvidence,
  createAffordabilitySnapshot,
  createBureauDecisionEvidence,
  normaliseAffordabilityDebts,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
import { createPasqEvidence } from "@/lib/compliance/pasq"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { createCreditLifeDisclosureSha256, createCreditLifeNoOfferDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"

const {
  requireOwnerOrStaffMock,
  requireApiRoleMock,
  applicationFindUniqueMock,
  applicationFindFirstMock,
  documentFindFirstMock,
  documentCreateMock,
  documentRetireMock,
  documentAccessCreateMock,
  tenantFindUniqueMock,
  insuranceProductFindFirstMock,
  complianceFindUniqueMock,
  complianceCreateMock,
  complianceUpdateManyMock,
  auditCreateMock,
  applicationUpdateManyMock,
  queryRawMock,
  transactionMock,
  generatePdfMock,
  saveFileMock,
  readFileMock,
  deleteFileMock,
  lockProviderIdentityMock,
  clientFindFirstMock,
  readCompositeKycStateMock,
} = vi.hoisted(() => ({
  clientFindFirstMock: vi.fn(),
  readCompositeKycStateMock: vi.fn(),
  requireOwnerOrStaffMock: vi.fn(),
  requireApiRoleMock: vi.fn(),
  applicationFindUniqueMock: vi.fn(),
  applicationFindFirstMock: vi.fn(),
  documentFindFirstMock: vi.fn(),
  documentCreateMock: vi.fn(),
  documentRetireMock: vi.fn(),
  documentAccessCreateMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  insuranceProductFindFirstMock: vi.fn(),
  complianceFindUniqueMock: vi.fn(),
  complianceCreateMock: vi.fn(),
  complianceUpdateManyMock: vi.fn(),
  auditCreateMock: vi.fn(),
  applicationUpdateManyMock: vi.fn(),
  queryRawMock: vi.fn(),
  transactionMock: vi.fn(),
  generatePdfMock: vi.fn(),
  saveFileMock: vi.fn(),
  readFileMock: vi.fn(),
  deleteFileMock: vi.fn(),
  lockProviderIdentityMock: vi.fn(),
}))

// No tenant logo: documents print the text letterhead (lib/config/lender-logo.ts).
vi.mock("@/lib/config/lender-logo", () => ({ getLenderLogo: async () => undefined }))
vi.mock("@/lib/auth-guards", () => ({
  requireOwnerOrStaff: (...args: unknown[]) => requireOwnerOrStaffMock(...args),
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, callback: (tenant: { id: string }) => unknown) =>
    callback({ id: "tenant-1" }),
}))
vi.mock("@/lib/compliance/statutory-provider-identity.server", () => ({
  statutoryProviderIdentityFromTenant: (tenant: {
    name: string
    config: { ncrNumber: string | null } | null
  }) => tenant.config ? {
    tenantName: tenant.name,
    configuredNcrNumber: tenant.config.ncrNumber,
    statutoryNcrNumber: tenant.config.ncrNumber ?? "NCRCP-TEST",
  } : null,
  lockCurrentStatutoryProviderIdentity: (...args: unknown[]) =>
    lockProviderIdentityMock(...args),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: {
      findUnique: (...args: unknown[]) => applicationFindUniqueMock(...args),
      findFirst: (...args: unknown[]) => applicationFindFirstMock(...args),
    },
    client: { findFirst: (...args: unknown[]) => clientFindFirstMock(...args) },
    clientDocument: { findFirst: (...args: unknown[]) => documentFindFirstMock(...args) },
    documentAccessLog: { create: (...args: unknown[]) => documentAccessCreateMock(...args) },
    tenant: { findUnique: (...args: unknown[]) => tenantFindUniqueMock(...args) },
    insuranceProduct: {
      findFirst: (...args: unknown[]) => insuranceProductFindFirstMock(...args),
    },
    complianceRecord: {
      findUnique: (...args: unknown[]) => complianceFindUniqueMock(...args),
    },
    $transaction: (...args: unknown[]) => transactionMock(...args),
  },
}))
vi.mock("@/lib/kyc/document-state", () => ({
  readCompositeKycState: (...args: unknown[]) => readCompositeKycStateMock(...args),
}))
vi.mock("@/lib/pdf/creditAgreement", () => ({
  generateCreditAgreementPdf: (...args: unknown[]) => generatePdfMock(...args),
}))
vi.mock("@/lib/storage", () => ({
  managedStoragePath: () => "/pasq/generated.pdf",
  saveFileToManagedPath: (...args: unknown[]) => saveFileMock(...args),
  readFile: (...args: unknown[]) => readFileMock(...args),
  deleteManagedFileStrict: (...args: unknown[]) => deleteFileMock(...args),
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: new Proxy({}, { get: (_target, key) => String(key) }),
}))
vi.mock("@/lib/compliance/sa-business-calendar.server", () => ({
  quotationValidUntilDateFromDatabase: vi.fn().mockResolvedValue("2026-07-30"),
}))

import { GET, POST } from "./route"

const context = { params: Promise.resolve({ id: "app-1" }) }
const generatedAt = new Date("2026-07-23T08:00:00.000Z")
const pdf = Buffer.from("%PDF-1.4 versioned PASQ")
const pdfSha256 = sha256DocumentBytes(pdf)
const ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED = process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED

const product = {
  id: "product-1",
  productType: "MICRO" as const,
  interestRatePm: 0.05,
  interestModel: "DAILY_ACCRUAL" as const,
  initiationFeeModel: "FLAT_PCT" as const,
  initiationFeePct: 0.15,
  initiationFeeMax: 105_000,
  monthlyServiceFee: 6_900,
}
const creditLifeDisclosure = {
  version: "credit-life-election-v1" as const,
  election: "ACCEPTED" as const,
  principalCents: 150_000,
  termDays: 60,
  monthlyPremiumCents: 675,
  productId: "credit-life-1",
  productName: "Acme Credit Life",
  insurerId: "insurer-1",
  insurerName: "Test Life",
}

// An APPROVED application ALWAYS carries an approval snapshot, and the quotation
// is now priced off the terms frozen in it rather than off the live product row.
// A fixture without one is not a lighter test double, it is an application state
// that cannot exist — so build a real, intact snapshot whose frozen terms are the
// product's current terms. The pricing is therefore identical to what the live
// product would have produced, which is what keeps the evidence hashes asserted
// throughout this file stable.
const affordabilitySubject = {
  id: "client-1",
  grossMonthlyIncome: 2_000_000,
  monthlyIncome: 1_800_000,
  monthlyExpenses: 600_000,
  expenseBreakdown: {
    id: "expense-1",
    updatedAt: new Date("2026-07-23T07:00:00.000Z"),
    housing: 300_000,
    transport: 100_000,
    food: 150_000,
    education: 0,
    insurance: 0,
    clothing: 0,
    entertainment: 0,
    medical: 50_000,
    other: 0,
    belowMleJustification: null,
  },
}

// Approval precedes the ceremony: a snapshot whose calculator starts AFTER it
// was captured is rejected as non-intact, so anchor both to the approval moment.
const approvedAt = new Date("2026-07-23T07:45:00.000Z")

function approvalSnapshotFor(
  principalCents: number,
  termDays: number,
  approvedTerms: { interestRatePm?: number } = {},
) {
  const interestRatePm = approvedTerms.interestRatePm ?? product.interestRatePm
  const calculation = calculateLoan({
    principal: principalCents,
    termDays,
    productType: product.productType,
    interestRatePm,
    interestModel: product.interestModel,
    initiationFeeModel: product.initiationFeeModel,
    initiationFeePct: product.initiationFeePct,
    initiationFeeMax: product.initiationFeeMax,
    monthlyServiceFee: product.monthlyServiceFee,
    initiationFeePayment: "DEFERRED",
  }, approvedAt)
  const inputs = {
    monthlyIncomeCents: affordabilitySubject.monthlyIncome,
    monthlyExpensesCents: affordabilitySubject.monthlyExpenses,
    applicationDebtCents: 0,
    clientDebtCents: 0,
    declaredDebtCents: 0,
    bureauObligationsCents: 0,
    // NCA s.81 tests what the consumer is actually billed: instalment + premium.
    proposedInstalmentCents:
      calculation.monthlyInstalment + creditLifeDisclosure.monthlyPremiumCents,
    creditLifePremiumCents: creditLifeDisclosure.monthlyPremiumCents,
    principalCents,
    termDays,
    productId: product.id,
    interestRatePm,
    productType: product.productType,
    interestModel: product.interestModel,
    initiationFeeModel: product.initiationFeeModel,
    initiationFeePct: product.initiationFeePct,
    initiationFeeMaxCents: product.initiationFeeMax,
    monthlyServiceFeeCents: product.monthlyServiceFee,
    initiationFeePayment: "DEFERRED" as const,
    ndiBufferPct: 110,
  }
  const gate = evaluateAffordabilityGate(inputs)
  return withAffordabilitySnapshot(null, createAffordabilitySnapshot({
    stage: "APPROVAL",
    policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
    capturedAt: approvedAt,
    capturedById: "officer-1",
    inputs,
    applicationDebts: normaliseAffordabilityDebts([]),
    clientDebts: normaliseAffordabilityDebts([]),
    expenseEvidence: createAffordabilityExpenseEvidence(affordabilitySubject),
    bureauEvidence: createBureauDecisionEvidence({
      check: null,
      minimumScore: 450,
      blockAdverse: false,
      override: {
        reason: "Manual verification",
        byId: "officer-1",
        at: approvedAt,
      },
    }),
    calculation,
    calculationStartDate: approvedAt,
    outcome: {
      netDisposableIncomeCents: gate.ndi,
      ndiAfterLoanCents: gate.ndi - inputs.proposedInstalmentCents,
      requiredNdiCents: gate.requiredNdi,
      isAffordable: !gate.blocked,
      reason: gate.reason ?? null,
    },
  }))
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    affordabilityResult: approvalSnapshotFor(
      creditLifeDisclosure.principalCents,
      creditLifeDisclosure.termDays,
    ),
    id: "app-1",
    tenantId: "tenant-1",
    // The quotation is issued at the head of the signing ceremony, against an
    // APPROVED application (NCA s.92(1) binds it to entering into the
    // agreement, not to the credit decision).
    status: "APPROVED",
    agreementGeneratedAt: null,
    updatedAt: new Date("2026-07-23T07:55:00.000Z"),
    reference: "APP-TEST-1",
    agreementType: "SHORT_TERM",
    clientId: "client-1",
    productId: product.id,
    appliedAmount: creditLifeDisclosure.principalCents,
    appliedTermDays: creditLifeDisclosure.termDays,
    approvedAmount: creditLifeDisclosure.principalCents,
    approvedTermDays: creditLifeDisclosure.termDays,
    initiationFeePayment: "DEFERRED" as const,
    pasqVersion: null,
    pasqGeneratedAt: null,
    pasqDocumentId: null,
    pasqDocumentSha256: null,
    pasqEvidence: null,
    pasqEvidenceSha256: null,
    pasqAcknowledgedAt: null,
    pasqAcknowledgedBy: null,
    pasqAcknowledgedSha256: null,
    approvedPasqDocumentSha256: null,
    creditLifeElection: creditLifeDisclosure.election,
    creditLifeProductId: creditLifeDisclosure.productId,
    creditLifeProductName: creditLifeDisclosure.productName,
    creditLifeInsurerId: creditLifeDisclosure.insurerId,
    creditLifeInsurerName: creditLifeDisclosure.insurerName,
    creditLifeMonthlyPremiumCents: creditLifeDisclosure.monthlyPremiumCents,
    creditLifeDisclosureVersion: creditLifeDisclosure.version,
    creditLifeDisclosureSha256: createCreditLifeDisclosureSha256(creditLifeDisclosure),
    creditLifeDisclosureAcknowledgedAt: new Date("2026-07-23T07:50:00.000Z"),
    creditLifeDisclosureAcknowledgedBy: "client-1",
    client: {
      id: "client-1",
      updatedAt: new Date("2026-07-23T07:54:00.000Z"),
      firstName: "Synthetic",
      lastName: "Customer",
      idNumber: "9001015000086",
      addressLine1: "1 Test Street",
      city: "Johannesburg",
    },
    product: { ...product },
    ...overrides,
  }
}

// The payout-grade subject the quotation gate reads. VERIFIED here so the
// default fixture issues a quotation; individual tests degrade it.
function kycSubject(overrides: Record<string, unknown> = {}) {
  return {
    id: "client-1",
    idNumber: "9001015000086",
    firstName: "Synthetic",
    lastName: "Customer",
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
    kycStatus: "VERIFIED" as const,
    kycVerifiedAt: new Date("2026-07-23T07:30:00.000Z"),
    kycVerifiedById: "officer-1",
    kycVerificationMethod: "BIOMETRIC" as const,
    kycManualRejectionActive: false,
    ...overrides,
  }
}

function request(method: "GET" | "POST") {
  return new NextRequest("http://localhost/api/applications/app-1/pasq", { method })
}

function currentEvidence(app = application()) {
  const calculation = calculateLoan({
    principal: app.appliedAmount,
    termDays: app.appliedTermDays,
    productType: app.product.productType,
    interestRatePm: app.product.interestRatePm,
    interestModel: app.product.interestModel,
    initiationFeeModel: app.product.initiationFeeModel,
    initiationFeePct: app.product.initiationFeePct,
    initiationFeeMax: app.product.initiationFeeMax,
    monthlyServiceFee: app.product.monthlyServiceFee,
    initiationFeePayment: app.initiationFeePayment,
  }, generatedAt)
  return createPasqEvidence({
    tenantId: "tenant-1",
    applicationId: app.id,
    clientId: app.clientId,
    productId: app.productId,
    termDays: app.appliedTermDays,
    generatedAt,
    calculator: createAffordabilityCalculatorEvidence(calculation, generatedAt),
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
}

function lockedRow(app = application()) {
  return {
    applicationUpdatedAt: app.updatedAt,
    clientUpdatedAt: app.client.updatedAt,
    status: app.status,
    pasqDocumentId: null,
    productType: app.product.productType,
    interestRatePm: app.product.interestRatePm,
    interestModel: app.product.interestModel,
    initiationFeeModel: app.product.initiationFeeModel,
    initiationFeePct: app.product.initiationFeePct,
    initiationFeeMax: app.product.initiationFeeMax,
    monthlyServiceFee: app.product.monthlyServiceFee,
    creditLifeProductId: app.creditLifeProductId,
    creditLifeProductName: app.creditLifeProductName,
    creditLifeInsurerId: app.creditLifeInsurerId,
    creditLifeInsurerName: app.creditLifeInsurerName,
  }
}

beforeEach(() => {
  process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED = "true"
  vi.useFakeTimers()
  vi.setSystemTime(generatedAt)
  vi.clearAllMocks()
  lockProviderIdentityMock.mockResolvedValue(true)
  requireOwnerOrStaffMock.mockResolvedValue({
    type: "client",
    clientId: "client-1",
  })
  requireApiRoleMock.mockResolvedValue({
    user: { id: "officer-1", email: "officer@example.test" },
  })
  applicationFindUniqueMock.mockResolvedValue(application())
  applicationFindFirstMock.mockResolvedValue(null)
  clientFindFirstMock.mockResolvedValue(kycSubject())
  readCompositeKycStateMock.mockResolvedValue({
    ok: true,
    biometricEvidence: null,
    missingCoreDocuments: [],
    manualRejectionActive: false,
  })
  documentFindFirstMock.mockResolvedValue(null)
  documentCreateMock.mockImplementation(({ data }: { data: { id: string } }) => Promise.resolve(data))
  documentRetireMock.mockResolvedValue({ count: 0 })
  documentAccessCreateMock.mockResolvedValue({ id: "access-1" })
  tenantFindUniqueMock.mockResolvedValue({
    id: "tenant-1",
    name: "Acme Test",
    config: { ncrNumber: "NCRCP-TEST" },
  })
  insuranceProductFindFirstMock.mockResolvedValue({
    id: creditLifeDisclosure.productId,
  })
  complianceCreateMock.mockResolvedValue({ id: "staging-1" })
  complianceFindUniqueMock.mockResolvedValue(null)
  complianceUpdateManyMock.mockResolvedValue({ count: 1 })
  auditCreateMock.mockResolvedValue({ id: "audit-1" })
  applicationUpdateManyMock.mockResolvedValue({ count: 1 })
  queryRawMock.mockResolvedValue([lockedRow()])
  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
    loanApplication: { updateMany: applicationUpdateManyMock },
    clientDocument: {
      create: documentCreateMock,
      updateMany: (...args: unknown[]) => documentRetireMock(...args),
    },
    complianceRecord: { create: complianceCreateMock, updateMany: complianceUpdateManyMock },
    auditLog: { create: auditCreateMock },
  }))
  generatePdfMock.mockResolvedValue(pdf)
  saveFileMock.mockResolvedValue({ storagePath: "/pasq/generated.pdf", fileSize: pdf.length })
  readFileMock.mockResolvedValue(pdf)
  deleteFileMock.mockResolvedValue(undefined)
})

afterEach(() => {
  if (ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED === undefined) {
    delete process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  } else {
    process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED = ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  }
  vi.useRealTimers()
})

describe("versioned PASQ artifact route", () => {
  it("serves only intact bound bytes and logs the client view", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      clientId: "client-1",
      pasqGeneratedAt: generatedAt,
      pasqDocumentId: "pasq-1",
      pasqDocumentSha256: pdfSha256,
    })
    documentFindFirstMock.mockResolvedValue({ id: "pasq-1", storagePath: "/pasq/generated.pdf" })

    const response = await GET(request("GET"), context)

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response.headers.get("X-Document-SHA256")).toBe(pdfSha256)
    expect(documentAccessCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: "pasq-1",
        accessorType: "client",
        accessorId: "client-1",
        action: "view",
      }),
    })
  })

  it("rejects tampered bound bytes without recording a view", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      clientId: "client-1",
      pasqGeneratedAt: generatedAt,
      pasqDocumentId: "pasq-1",
      pasqDocumentSha256: pdfSha256,
    })
    documentFindFirstMock.mockResolvedValue({ id: "pasq-1", storagePath: "/pasq/generated.pdf" })
    readFileMock.mockResolvedValue(Buffer.from("tampered"))

    const response = await GET(request("GET"), context)

    expect(response.status).toBe(422)
    expect(documentAccessCreateMock).not.toHaveBeenCalled()
  })

  it("requires UNDER_REVIEW before generating", async () => {
    applicationFindUniqueMock.mockResolvedValue(application({ status: "SUBMITTED" }))

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(409)
    expect(generatePdfMock).not.toHaveBeenCalled()
  })

  it("rejects missing or tampered credit-life disclosure evidence", async () => {
    applicationFindUniqueMock.mockResolvedValue(application({
      creditLifeDisclosureSha256: "a".repeat(64),
    }))

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(422)
    expect((await response.json()).creditLifeEvidence).toBe("hash_mismatch")
    expect(generatePdfMock).not.toHaveBeenCalled()
  })

  it("rejects a stale election when the offered product or insurer is inactive", async () => {
    insuranceProductFindFirstMock.mockResolvedValue(null)

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      creditLifeEvidence: "availability_changed",
    }))
    expect(generatePdfMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  // Fair Score audit B6: the stored no-offer record, and only it, prints
  // "Credit Life: Not offered" on the quotation.
  it("tells the renderer the record is not-offered for a no-offer application", async () => {
    insuranceProductFindFirstMock.mockResolvedValue(null)
    const noOffer = application({
      creditLifeElection: "DECLINED",
      creditLifeProductId: null,
      creditLifeProductName: null,
      creditLifeInsurerId: null,
      creditLifeInsurerName: null,
      creditLifeMonthlyPremiumCents: 0,
      creditLifeDisclosureVersion: "credit-life-no-offer-v1",
      creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256({
        version: "credit-life-no-offer-v1", election: "DECLINED",
        principalCents: creditLifeDisclosure.principalCents, termDays: creditLifeDisclosure.termDays,
      }),
    })
    applicationFindUniqueMock.mockResolvedValue(noOffer)
    queryRawMock.mockResolvedValue([lockedRow(noOffer)])

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(200)
    expect(generatePdfMock).toHaveBeenCalledWith(expect.objectContaining({ creditLifeNotOffered: true }))
    expect(generatePdfMock.mock.calls[0][0].creditLife).toBeUndefined()
  })

  it("requires the persisted offer to remain a CREDIT_LIFE product", async () => {
    const response = await POST(request("POST"), context)

    expect(response.status).toBe(200)
    expect(insuranceProductFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: creditLifeDisclosure.productId,
          tenantId: "tenant-1",
          type: "CREDIT_LIFE",
          active: true,
        }),
      }),
    )
    const lockedQuery = queryRawMock.mock.calls
      .map(([query]) => {
        const sql = query as { strings?: readonly string[] }
        return sql.strings?.join(" ") ?? String(query)
      })
      .join("\n")
    expect(lockedQuery).toContain(
      `credit_life_product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"`,
    )
  })

  it("refuses to issue a quotation before the credit decision", async () => {
    applicationFindUniqueMock.mockResolvedValue(application({ status: "UNDER_REVIEW" }))

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/approved application/i)
    expect(applicationUpdateManyMock).not.toHaveBeenCalled()
  })

  // Approval clears the lenient "origination" KYC grade; the agreement route
  // demands the strict "payout" grade. Without this gate on the mint route, an
  // approved application issues a real s.92 quotation that no agreement can
  // follow, and the consumer signs the quotation believing it is the credit
  // agreement. The document must never be written.
  it("refuses to issue a quotation when composite KYC is not payout-grade", async () => {
    readCompositeKycStateMock.mockResolvedValue({
      ok: false,
      biometricEvidence: "biometric_evidence_missing",
      missingCoreDocuments: [],
    })

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.compositeKyc).toBe("payout_grade_required")
    expect(body.biometricEvidence).toBe("biometric_evidence_missing")
    // No PDF rendered, nothing stored, no document row, no state write.
    expect(generatePdfMock).not.toHaveBeenCalled()
    expect(saveFileMock).not.toHaveBeenCalled()
    expect(documentCreateMock).not.toHaveBeenCalled()
    expect(applicationUpdateManyMock).not.toHaveBeenCalled()
  })

  it("refuses to issue a quotation when the cached KYC projection is not VERIFIED", async () => {
    // The composite evidence can read ok while the cached projection disagrees;
    // the payout grade in current-approval.ts requires BOTH, so this route must
    // too, or the quotation gate is weaker than the agreement gate it mirrors.
    clientFindFirstMock.mockResolvedValue(kycSubject({ kycStatus: "PENDING" }))
    readCompositeKycStateMock.mockResolvedValue({
      ok: true,
      biometricEvidence: null,
      missingCoreDocuments: [],
    })

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(422)
    expect((await response.json()).compositeKyc).toBe("payout_grade_required")
    expect(generatePdfMock).not.toHaveBeenCalled()
    expect(documentCreateMock).not.toHaveBeenCalled()
  })

  // A manual rejection forces composite ok=false regardless of documents or
  // biometrics, and only an authorised KYC decision clears it. Telling staff to
  // capture a selfie sends them to do something that CANNOT work.
  // lib/kyc/kyc-blockers.ts already returns this blocker alone for that reason.
  it("names the manual rejection instead of sending staff to re-capture a selfie", async () => {
    readCompositeKycStateMock.mockResolvedValue({
      ok: false,
      biometricEvidence: "biometric_evidence_missing",
      missingCoreDocuments: [],
      manualRejectionActive: true,
    })

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.compositeKyc).toBe("manual_rejection_active")
    expect(body.manualRejectionActive).toBe(true)
    expect(body.error).toMatch(/authorised KYC decision/i)
    // The remedy that cannot work must not be suggested.
    expect(body.error).not.toMatch(/selfie/i)
    expect(body.error).not.toMatch(/in-person verification/i)
    expect(generatePdfMock).not.toHaveBeenCalled()
    expect(documentCreateMock).not.toHaveBeenCalled()
  })

  it("keeps the biometric remedy copy when there is no manual rejection", async () => {
    readCompositeKycStateMock.mockResolvedValue({
      ok: false,
      biometricEvidence: "biometric_evidence_missing",
      missingCoreDocuments: [],
      manualRejectionActive: false,
    })

    const response = await POST(request("POST"), context)

    const body = await response.json()
    expect(body.compositeKyc).toBe("payout_grade_required")
    expect(body.manualRejectionActive).toBe(false)
    expect(body.error).toMatch(/selfie|biometric/i)
  })

  it("refuses to issue a quotation when the client record cannot be read", async () => {
    clientFindFirstMock.mockResolvedValue(null)

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(422)
    expect((await response.json()).compositeKyc).toBe("client_unavailable")
    expect(generatePdfMock).not.toHaveBeenCalled()
    expect(documentCreateMock).not.toHaveBeenCalled()
  })

  it("refuses to re-issue a quotation once the agreement exists", async () => {
    applicationFindUniqueMock.mockResolvedValue(application({
      agreementGeneratedAt: new Date("2026-07-23T08:10:00.000Z"),
    }))

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/already been generated/i)
    expect(applicationUpdateManyMock).not.toHaveBeenCalled()
  })

  it("refuses to quote terms that differ from the ones approved", async () => {
    // The evidence is bound to appliedAmount/appliedTermDays in the database,
    // so a drifted approval would produce a quotation stating a loan the
    // consumer was never granted.
    applicationFindUniqueMock.mockResolvedValue(application({
      approvedAmount: creditLifeDisclosure.principalCents + 100_00,
    }))

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      pricingEvidence: "approved_terms_drifted",
    })
    expect(applicationUpdateManyMock).not.toHaveBeenCalled()
  })

  it("leaves the ceremony digest unset at issue", async () => {
    // approvedPasqDocumentSha256 is pinned at ACKNOWLEDGEMENT. Setting it here
    // would make it satisfiable in a state where the consumer has seen nothing.
    const response = await POST(request("POST"), context)

    expect(response.status).toBe(200)
    expect(applicationUpdateManyMock.mock.calls[0][0].data)
      .toMatchObject({ approvedPasqDocumentSha256: null })
  })

  it("persists an exact total-cost evidence hash and the matching PASQ document", async () => {
    const response = await POST(request("POST"), context)

    expect(response.status).toBe(200)
    const update = applicationUpdateManyMock.mock.calls[0][0].data
    expect(update.pasqVersion).toBe("pasq-v3")
    expect(update.pasqEvidence.tenantId).toBe("tenant-1")
    expect(update.pasqDocumentSha256).toBe(pdfSha256)
    expect(update.pasqEvidenceSha256).toBe(update.pasqEvidence.evidenceSha256)
    expect(update.pasqEvidence.creditLife).toMatchObject({
      election: "ACCEPTED",
      monthlyPremiumCents: 675,
      premiumPeriods: 2,
      totalPremiumCents: 1_350,
    })
    expect(update.pasqEvidence.totalCostOfCreditCents).toBe(
      update.pasqEvidence.calculator.principalCents
      + update.pasqEvidence.calculator.totalInterestCents
      + update.pasqEvidence.calculator.serviceFeesCents
      + update.pasqEvidence.calculator.initiationFeeCents
      + 1_350,
    )
    expect(generatePdfMock).toHaveBeenCalledWith(expect.objectContaining({
      startDate: generatedAt,
      creditLife: expect.objectContaining({
        elected: true,
        monthlyPremiumCents: 675,
        premiumPeriods: 2,
        totalPremiumCents: 1_350,
      }),
      creditLifeNotOffered: false,
    }))
    expect(documentCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        docType: "FORM_20_PRE_AGREEMENT",
        storagePath: "/pasq/generated.pdf",
        contentSha256: pdfSha256,
      }),
    })
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PASQ_GENERATED",
        newValue: expect.objectContaining({
          documentSha256: pdfSha256,
          evidenceSha256: update.pasqEvidenceSha256,
          creditLifeTotalPremiumCents: 1_350,
        }),
      }),
    })
    expect(queryRawMock).toHaveBeenCalledTimes(2)
  })

  // Pricing drift is now measured against the terms the application was APPROVED
  // on, so a stale quotation is one that disagrees with the frozen snapshot.
  it("does not return an existing PASQ after the approved pricing changed", async () => {
    const evidence = currentEvidence()
    applicationFindUniqueMock.mockResolvedValue(application({
      pasqVersion: "pasq-v3",
      pasqGeneratedAt: generatedAt,
      pasqDocumentId: "pasq-1",
      pasqDocumentSha256: pdfSha256,
      pasqEvidence: evidence,
      pasqEvidenceSha256: evidence.evidenceSha256,
      affordabilityResult: approvalSnapshotFor(
        creditLifeDisclosure.principalCents,
        creditLifeDisclosure.termDays,
        { interestRatePm: 0.06 },
      ),
    }))

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(409)
    expect(documentFindFirstMock).not.toHaveBeenCalled()
  })

  // The counterpart, and the whole point of pricing off the approval: routine
  // maintenance of the LoanProduct row must not reach backwards and invalidate a
  // quotation already issued against an approved loan.
  it("keeps an existing PASQ valid when the live product row is repriced", async () => {
    const evidence = currentEvidence()
    documentFindFirstMock.mockResolvedValue({
      id: "pasq-1",
      storagePath: "/pasq/generated.pdf",
      contentSha256: pdfSha256,
    })
    readFileMock.mockResolvedValue(pdf)
    applicationFindUniqueMock.mockResolvedValue(application({
      pasqVersion: "pasq-v3",
      pasqGeneratedAt: generatedAt,
      pasqDocumentId: "pasq-1",
      pasqDocumentSha256: pdfSha256,
      pasqEvidence: evidence,
      pasqEvidenceSha256: evidence.evidenceSha256,
      // Product edited AFTER approval — irrelevant to this loan's agreed price.
      product: { ...product, interestRatePm: 0.06, interestModel: "FLAT" as const },
    }))

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(200)
  })

  // A corrupt or absent approval snapshot is an APPROVAL-evidence failure. It
  // was previously reported under the credit-life message, which sent operators
  // to re-capture a cover election -- a remedy that cannot fix it.
  it("reports an unusable approval snapshot as approval evidence, not credit life", async () => {
    // schemaVersion MUST be current: readAffordabilitySnapshotStore returns a
    // legacy store with no `approval` key for any older version, which would
    // land this on the "absent" branch and leave the policy clause untested.
    const superseded = approvalSnapshotFor(
      creditLifeDisclosure.principalCents,
      creditLifeDisclosure.termDays,
    ) as unknown as { schemaVersion: number; approval: Record<string, unknown> }
    applicationFindUniqueMock.mockResolvedValue(application({
      affordabilityResult: {
        ...superseded,
        approval: { ...superseded.approval, policyVersion: "approval-ndi-v0" },
      },
    }))

    const response = await POST(request("POST"), context)
    const body = await response.json() as {
      error: string
      affordabilitySnapshot?: string
      creditLifeEvidence?: string
    }

    expect(response.status).toBe(409)
    expect(body.affordabilitySnapshot).toBe("missing")
    expect(body.creditLifeEvidence).toBeUndefined()
    expect(body.error).not.toMatch(/credit-life/i)
  })

  // The same failure on the OTHER buildEvidence call site. An application that
  // already holds a PASQ took a different branch and reported a PASQ defect.
  it("reports an unusable approval snapshot when revalidating an existing PASQ", async () => {
    const evidence = currentEvidence()
    const intact = approvalSnapshotFor(
      creditLifeDisclosure.principalCents,
      creditLifeDisclosure.termDays,
    ) as unknown as { schemaVersion: number; approval: Record<string, unknown> }
    applicationFindUniqueMock.mockResolvedValue(application({
      pasqVersion: "pasq-v3",
      pasqGeneratedAt: generatedAt,
      pasqDocumentId: "pasq-1",
      pasqDocumentSha256: pdfSha256,
      pasqEvidence: evidence,
      pasqEvidenceSha256: evidence.evidenceSha256,
      affordabilityResult: {
        ...intact,
        approval: { ...intact.approval, decisionFingerprint: "0".repeat(64) },
      },
    }))

    const response = await POST(request("POST"), context)
    const body = await response.json() as { error: string; affordabilitySnapshot?: string }

    expect(response.status).toBe(409)
    expect(body.affordabilitySnapshot).toBe("changed")
    expect(body.error).not.toMatch(/existing PASQ is incomplete/i)
  })

  // s.92 disclosure: the rate PRINTED on the quotation has to be the rate the
  // schedule beside it was computed at. Rendering the live product row here
  // would state one rate over a schedule priced at another.
  it("renders the quotation on the approved terms, not the live product row", async () => {
    // A real product edit is visible to BOTH the load and the lock re-read, so
    // move them together — otherwise the concurrency guard fires first and this
    // never reaches the renderer it is meant to exercise.
    const repriced = application({
      product: { ...product, interestRatePm: 0.06, interestModel: "FLAT" as const },
    })
    applicationFindUniqueMock.mockResolvedValue(repriced)
    queryRawMock.mockResolvedValue([lockedRow(repriced)])

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(200)
    expect(generatePdfMock).toHaveBeenCalledWith(expect.objectContaining({
      product: expect.objectContaining({
        interestRatePm: product.interestRatePm,
        interestModel: product.interestModel,
        monthlyServiceFee: product.monthlyServiceFee,
      }),
    }))
  })

  it("does not return an existing PASQ whose stored bytes are tampered", async () => {
    const evidence = currentEvidence()
    applicationFindUniqueMock.mockResolvedValue(application({
      pasqVersion: "pasq-v3",
      pasqGeneratedAt: generatedAt,
      pasqDocumentId: "pasq-1",
      pasqDocumentSha256: pdfSha256,
      pasqEvidence: evidence,
      pasqEvidenceSha256: evidence.evidenceSha256,
    }))
    documentFindFirstMock.mockResolvedValue({ id: "pasq-1", storagePath: "/pasq/generated.pdf" })
    readFileMock.mockResolvedValue(Buffer.from("tampered existing PASQ"))

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/integrity/i)
  })

  it("fails before storage when the locked application no longer matches", async () => {
    queryRawMock.mockResolvedValue([])

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(409)
    expect(saveFileMock).not.toHaveBeenCalled()
    expect(documentCreateMock).not.toHaveBeenCalled()
  })

  it("fails before storage when the statutory provider identity changes after rendering", async () => {
    lockProviderIdentityMock.mockResolvedValue(false)

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(409)
    expect(saveFileMock).not.toHaveBeenCalled()
    expect(documentCreateMock).not.toHaveBeenCalled()
  })

  it("returns 409 while the PASQ staging lease is still active", async () => {
    complianceFindUniqueMock.mockResolvedValue({
      id: "staging-stale",
      tenantId: "tenant-1",
      status: "PENDING",
      dueDate: new Date(generatedAt.getTime() + 60_000),
      data: {
        kind: "PASQ_ARTIFACT",
        lifecycle: "STAGING",
        applicationId: "app-1",
        documentId: "doc-stale",
        documentSha256: "a".repeat(64),
        evidenceSha256: "b".repeat(64),
        storagePath: "/pasq/generated.pdf",
        fileName: "pasq-app-1.pdf",
        fileSize: 123,
        stagedAt: new Date(generatedAt.getTime() - 60_000).toISOString(),
      },
    })

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(409)
    expect((await response.json()).pasqIntegrity).toBe("staging_in_progress")
    expect(deleteFileMock).not.toHaveBeenCalled()
    expect(generatePdfMock).not.toHaveBeenCalled()
  })

  it("claims, audits and cleans an expired PASQ staging lease before retrying", async () => {
    complianceFindUniqueMock.mockResolvedValue({
      id: "staging-stale",
      tenantId: "tenant-1",
      status: "PENDING",
      dueDate: new Date(generatedAt.getTime() - 1),
      data: {
        kind: "PASQ_ARTIFACT",
        lifecycle: "STAGING",
        applicationId: "app-1",
        documentId: "doc-stale",
        documentSha256: "a".repeat(64),
        evidenceSha256: "b".repeat(64),
        storagePath: "/pasq/generated.pdf",
        fileName: "pasq-app-1.pdf",
        fileSize: 123,
        stagedAt: new Date(generatedAt.getTime() - 16 * 60_000).toISOString(),
      },
    })

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(200)
    expect(deleteFileMock).toHaveBeenCalledWith("/pasq/generated.pdf")
    expect(complianceUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "staging-stale",
        data: { path: ["lifecycle"], equals: "STAGING" },
      }),
      data: {
        data: expect.objectContaining({ lifecycle: "RECONCILING" }),
      },
    }))
    expect(complianceUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "staging-stale",
        data: { path: ["lifecycle"], equals: "RECONCILING" },
      }),
      data: expect.objectContaining({
        idempotencyKey: null,
        data: expect.objectContaining({ lifecycle: "FAILED" }),
      }),
    }))
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PASQ_ARTIFACT_STAGING_RECOVERY_STARTED",
      }),
    })
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PASQ_ARTIFACT_STAGING_FAILED",
      }),
    })
    expect(complianceCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        idempotencyKey: "pasq-artifact:tenant-1:app-1",
      }),
      select: { id: true },
    })
  })
})
