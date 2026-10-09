import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { calculateLoan } from "@/lib/loan-calculator"
import {
  APPROVAL_AFFORDABILITY_POLICY_VERSION,
  createAffordabilityExpenseEvidence,
  createAffordabilitySnapshot,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"

const {
  requireOwnerOrStaffMock,
  requireApiRoleMock,
  applicationFindUniqueMock,
  applicationFindFirstMock,
  transactionMock,
  txApplicationUpdateManyMock,
  txQueryRawMock,
  txDocumentCreateMock,
  txDocumentUpdateManyMock,
  txComplianceCreateMock,
  txComplianceUpdateManyMock,
  txAuditCreateMock,
  complianceFindUniqueMock,
  auditFindFirstMock,
  documentFindFirstMock,
  documentAccessCreateMock,
  tenantFindUniqueMock,
  bureauCheckFindFirstMock,
  tenantConfigFindUniqueMock,
  insuranceProductFindFirstMock,
  verifyCurrentAffordabilityApprovalMock,
  verifyLockedCurrentAffordabilityApprovalMock,
  verifyStoredPasqBindingMock,
  verifyPasqDocumentArtifactMock,
  generateCreditAgreementPdfMock,
  saveFileToManagedPathMock,
  deleteManagedFileStrictMock,
  readFileMock,
  lockProviderIdentityMock,
  quotationValidUntilDateFromDatabaseMock,
} = vi.hoisted(() => ({
  requireOwnerOrStaffMock: vi.fn(),
  requireApiRoleMock: vi.fn(),
  applicationFindUniqueMock: vi.fn(),
  applicationFindFirstMock: vi.fn(),
  transactionMock: vi.fn(),
  txApplicationUpdateManyMock: vi.fn(),
  txQueryRawMock: vi.fn(),
  txDocumentCreateMock: vi.fn(),
  txDocumentUpdateManyMock: vi.fn(),
  txComplianceCreateMock: vi.fn(),
  txComplianceUpdateManyMock: vi.fn(),
  txAuditCreateMock: vi.fn(),
  complianceFindUniqueMock: vi.fn(),
  auditFindFirstMock: vi.fn(),
  documentFindFirstMock: vi.fn(),
  documentAccessCreateMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  bureauCheckFindFirstMock: vi.fn(),
  tenantConfigFindUniqueMock: vi.fn(),
  insuranceProductFindFirstMock: vi.fn(),
  verifyCurrentAffordabilityApprovalMock: vi.fn(),
  verifyLockedCurrentAffordabilityApprovalMock: vi.fn(),
  verifyStoredPasqBindingMock: vi.fn(),
  verifyPasqDocumentArtifactMock: vi.fn(),
  generateCreditAgreementPdfMock: vi.fn(),
  saveFileToManagedPathMock: vi.fn(),
  deleteManagedFileStrictMock: vi.fn(),
  readFileMock: vi.fn(),
  lockProviderIdentityMock: vi.fn(),
  quotationValidUntilDateFromDatabaseMock: vi.fn(),
}))

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
    clientDocument: {
      findFirst: (...args: unknown[]) => documentFindFirstMock(...args),
    },
    complianceRecord: {
      findUnique: (...args: unknown[]) => complianceFindUniqueMock(...args),
    },
    auditLog: {
      findFirst: (...args: unknown[]) => auditFindFirstMock(...args),
    },
    documentAccessLog: { create: (...args: unknown[]) => documentAccessCreateMock(...args) },
    tenant: { findUnique: (...args: unknown[]) => tenantFindUniqueMock(...args) },
    creditBureauCheck: { findFirst: (...args: unknown[]) => bureauCheckFindFirstMock(...args) },
    tenantConfig: { findUnique: (...args: unknown[]) => tenantConfigFindUniqueMock(...args) },
    insuranceProduct: {
      findFirst: (...args: unknown[]) => insuranceProductFindFirstMock(...args),
    },
    $transaction: (...args: unknown[]) => transactionMock(...args),
  },
}))
vi.mock("@/lib/pdf/creditAgreement", () => ({
  // The route renders through the anchors-returning entry point so it can
  // record where the signature rules landed; countersignature stamps onto
  // those exact coordinates instead of re-rendering the document.
  generateCreditAgreementPdfWithAnchors: (...args: unknown[]) =>
    generateCreditAgreementPdfMock(...args),
}))
vi.mock("@/lib/storage", () => ({
  managedStoragePath: () => "/agreements/app-1.pdf",
  saveFileToManagedPath: (...args: unknown[]) => saveFileToManagedPathMock(...args),
  deleteManagedFileStrict: (...args: unknown[]) => deleteManagedFileStrictMock(...args),
  readFile: (...args: unknown[]) => readFileMock(...args),
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: new Proxy({}, { get: (_target, key) => String(key) }),
}))
vi.mock("@/lib/affordability/current-approval", () => ({
  verifyCurrentAffordabilityApproval: (...args: unknown[]) =>
    verifyCurrentAffordabilityApprovalMock(...args),
  verifyLockedCurrentAffordabilityApproval: (...args: unknown[]) =>
    verifyLockedCurrentAffordabilityApprovalMock(...args),
}))
vi.mock("@/lib/compliance/pasq", () => ({
  verifyStoredPasqBinding: (...args: unknown[]) => verifyStoredPasqBindingMock(...args),
}))
vi.mock("@/lib/compliance/pasq-document.server", () => ({
  verifyPasqDocumentArtifact: (...args: unknown[]) => verifyPasqDocumentArtifactMock(...args),
}))
vi.mock("@/lib/compliance/sa-business-calendar.server", () => ({
  quotationValidUntilDateFromDatabase: (...args: unknown[]) =>
    quotationValidUntilDateFromDatabaseMock(...args),
}))

import { GET, PATCH, POST } from "./route"

const context = { params: Promise.resolve({ id: "app-1" }) }
const frozenStart = new Date("2026-07-20T08:00:00.000Z")
const contractStart = new Date("2026-07-20T09:00:00.000Z")
const generatedPdf = Buffer.from("%PDF-1.4 frozen")
const generatedPdfSha256 = sha256DocumentBytes(generatedPdf)
/** Where this render put the blank signature rules — persisted in the artifact
 *  manifest so countersignature can stamp onto these exact coordinates. */
const renderedAnchors = {
  pageIndex: 3,
  fontSize: 9,
  consumer: { signatureX: 131, signatureWidth: 155, dateX: 314, dateWidth: 75, baselineY: 603 },
  provider: { signatureX: 171, signatureWidth: 100, dateX: 299, dateWidth: 75, baselineY: 531 },
}
const ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED =
  process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
const pricingInputs = {
  principal: 500_000,
  termDays: 30,
  interestRatePm: 0.03,
  interestModel: "DAILY_ACCRUAL" as const,
  initiationFeeModel: "FLAT_PCT" as const,
  initiationFeePct: 0.15,
  initiationFeeMax: 105_000,
  monthlyServiceFee: 6_900,
  productType: "MICRO",
  initiationFeePayment: "DEFERRED" as const,
}
const frozenCalculation = calculateLoan(pricingInputs, frozenStart)
const expenseEvidence = createAffordabilityExpenseEvidence({
  grossMonthlyIncome: 2_200_000,
  monthlyIncome: 2_000_000,
  monthlyExpenses: 800_000,
  expenseBreakdown: {
    id: "expense-1",
    updatedAt: new Date("2026-07-18T08:00:00.000Z"),
    housing: 400_000,
    transport: 100_000,
    food: 200_000,
    insurance: 50_000,
    medical: 50_000,
  },
})
const approval = createAffordabilitySnapshot({
  stage: "APPROVAL",
  policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
  capturedAt: frozenStart,
  capturedById: "officer-1",
  inputs: {
    monthlyIncomeCents: 2_000_000,
    monthlyExpensesCents: 800_000,
    applicationDebtCents: 0,
    clientDebtCents: 0,
    declaredDebtCents: 0,
    bureauObligationsCents: 0,
    proposedInstalmentCents: frozenCalculation.monthlyInstalment,
    principalCents: pricingInputs.principal,
    termDays: pricingInputs.termDays,
    productId: "product-1",
    interestRatePm: pricingInputs.interestRatePm,
    interestModel: pricingInputs.interestModel,
    initiationFeeModel: pricingInputs.initiationFeeModel,
    initiationFeePct: pricingInputs.initiationFeePct,
    initiationFeeMaxCents: pricingInputs.initiationFeeMax,
    monthlyServiceFeeCents: pricingInputs.monthlyServiceFee,
    initiationFeePayment: pricingInputs.initiationFeePayment,
    ndiBufferPct: 110,
  },
  applicationDebts: [],
  clientDebts: [],
  expenseEvidence,
  bureauEvidence: null,
  calculation: frozenCalculation,
  calculationStartDate: frozenStart,
  outcome: {
    netDisposableIncomeCents: 1_200_000,
    ndiAfterLoanCents: 1_200_000 - frozenCalculation.monthlyInstalment,
    requiredNdiCents: Math.ceil(frozenCalculation.monthlyInstalment * 1.1),
    isAffordable: true,
    reason: null,
  },
})
const affordabilityResult = withAffordabilitySnapshot(null, approval)
const creditLifeDisclosure = {
  version: "credit-life-election-v1" as const,
  election: "DECLINED" as const,
  principalCents: pricingInputs.principal,
  termDays: pricingInputs.termDays,
  monthlyPremiumCents: 2250,
  productId: "credit-life-1",
  productName: "Acme Credit Life",
  insurerId: "insurer-1",
  insurerName: "Test Life",
}

const summaryApplication = {
  id: "app-1",
  status: "APPROVED",
  updatedAt: new Date("2026-07-20T08:30:00.000Z"),
  reference: "APP-TEST-1",
  agreementType: "SMALL",
  clientId: "client-1",
  bureauReviewGeneration: "review-generation-1",
  agreementSignedAt: null,
  agreementGeneratedAt: null,
  agreementDocumentId: null,
  agreementDocumentSha256: null,
  initiationFeePayment: "DEFERRED",
  affordabilityResult,
  creditLifeElection: creditLifeDisclosure.election,
  creditLifeProductId: creditLifeDisclosure.productId,
  creditLifeProductName: creditLifeDisclosure.productName,
  creditLifeInsurerId: creditLifeDisclosure.insurerId,
  creditLifeInsurerName: creditLifeDisclosure.insurerName,
  creditLifeMonthlyPremiumCents: creditLifeDisclosure.monthlyPremiumCents,
  creditLifeDisclosureVersion: creditLifeDisclosure.version,
  creditLifeDisclosureSha256: createCreditLifeDisclosureSha256(creditLifeDisclosure),
  creditLifeDisclosureAcknowledgedAt: new Date("2026-07-19T10:00:00.000Z"),
  creditLifeDisclosureAcknowledgedBy: "client-1",
  pasqVersion: "pasq-v3",
  pasqGeneratedAt: frozenStart,
  pasqDocumentId: "pasq-doc-1",
  pasqDocumentSha256: "d".repeat(64),
  pasqEvidence: { version: "pasq-v3" },
  pasqEvidenceSha256: "e".repeat(64),
  pasqAcknowledgedAt: new Date("2026-07-20T08:10:00.000Z"),
  pasqAcknowledgedBy: "client-1",
  pasqAcknowledgedSha256: "d".repeat(64),
  approvedPasqDocumentSha256: "d".repeat(64),
  client: {
    updatedAt: new Date("2026-07-20T08:25:00.000Z"),
    firstName: "Jane",
    lastName: "Doe",
    idNumber: "8001015000086",
    addressLine1: "1 Test Street",
    city: "Johannesburg",
  },
}

function request(method: "GET" | "PATCH" | "POST", body?: unknown) {
  return new NextRequest("http://localhost/api/applications/app-1/agreement", {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  delete process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  vi.useFakeTimers()
  vi.setSystemTime(contractStart)
  vi.clearAllMocks()
  lockProviderIdentityMock.mockResolvedValue(true)
  quotationValidUntilDateFromDatabaseMock.mockResolvedValue("2026-07-27")
  verifyStoredPasqBindingMock.mockReset()
  verifyPasqDocumentArtifactMock.mockReset()
  requireOwnerOrStaffMock.mockResolvedValue({
    type: "staff",
    user: { id: "officer-1", email: "officer@example.test" },
  })
  requireApiRoleMock.mockResolvedValue({
    user: { id: "officer-1", email: "officer@example.test" },
  })
  txApplicationUpdateManyMock.mockResolvedValue({ count: 1 })
  txQueryRawMock.mockImplementation((query: { strings?: readonly string[] }) => {
    const sql = query?.strings?.join(" ") ?? String(query)
    return Promise.resolve(sql.includes('FROM "InsuranceProduct"')
      ? [{ id: creditLifeDisclosure.productId }]
      : [{ id: "staging-1" }])
  })
  txDocumentCreateMock.mockImplementation(
    ({ data }: { data: { id: string } }) => Promise.resolve({ id: data.id }),
  )
  txComplianceCreateMock.mockResolvedValue({ id: "staging-1" })
  txComplianceUpdateManyMock.mockResolvedValue({ count: 1 })
  txAuditCreateMock.mockResolvedValue({ id: "audit-1" })
  txDocumentUpdateManyMock.mockResolvedValue({ count: 1 })
  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    $queryRaw: (...args: unknown[]) => txQueryRawMock(...args),
    loanApplication: { updateMany: txApplicationUpdateManyMock },
    clientDocument: {
      create: txDocumentCreateMock,
      updateMany: txDocumentUpdateManyMock,
    },
    complianceRecord: {
      create: txComplianceCreateMock,
      updateMany: txComplianceUpdateManyMock,
    },
    auditLog: { create: txAuditCreateMock },
  }))
  documentFindFirstMock.mockResolvedValue(null)
  applicationFindFirstMock.mockResolvedValue(null)
  complianceFindUniqueMock.mockResolvedValue(null)
  auditFindFirstMock.mockResolvedValue(null)
  tenantFindUniqueMock.mockResolvedValue({
    id: "tenant-1",
    name: "Acme Test",
    config: { ncrNumber: "NCRCP-TEST" },
  })
  bureauCheckFindFirstMock.mockResolvedValue({ id: "bureau-1" })
  tenantConfigFindUniqueMock.mockResolvedValue({
    ndiBufferPct: 110,
    bureauMinScore: 450,
    bureauBlockAdverse: false,
  })
  insuranceProductFindFirstMock.mockResolvedValue({
    id: creditLifeDisclosure.productId,
  })
  verifyCurrentAffordabilityApprovalMock.mockReturnValue({
    ok: true,
    approval,
    calculation: frozenCalculation,
  })
  verifyLockedCurrentAffordabilityApprovalMock.mockResolvedValue({
    ok: true,
    application: summaryApplication,
    approval,
    calculation: frozenCalculation,
  })
  verifyStoredPasqBindingMock.mockReturnValue({
    ok: true,
    documentId: "pasq-doc-1",
    documentSha256: "d".repeat(64),
    evidence: {
      version: "pasq-v3",
      evidenceSha256: "e".repeat(64),
      totalCostOfCreditCents: 615_000,
      calculator: approval.calculator,
      creditLife: {
        premiumPeriods: 1,
        totalPremiumCents: 0,
      },
      billing: {
        version: "credit-life-billing-v1",
        collectionMethod: "INCLUDED_IN_LOAN_REPAYMENT",
        recurringPaymentCents: frozenCalculation.monthlyInstalment,
        totalRepayableCents: frozenCalculation.totalRepayable,
        schedule: frozenCalculation.schedule.map((item) => ({
          installmentNo: item.installmentNo,
          dueDate: item.dueDate.toISOString(),
          principalDueCents: item.principalDue,
          interestDueCents: item.interestDue,
          baseFeesDueCents: item.feesDue,
          creditLifePremiumDueCents: 0,
          feesDueCents: item.feesDue,
          totalDueCents: item.totalDue,
          openingBalanceCents: item.openingBalance,
          closingBalanceCents: item.closingBalance,
        })),
      },
    },
  })
  verifyPasqDocumentArtifactMock.mockResolvedValue({
    ok: true,
    document: {
      id: "pasq-doc-1",
      storagePath: "/pasq/pasq-doc-1.pdf",
      contentSha256: "d".repeat(64),
    },
    bytes: Buffer.from("%PDF-1.4 PASQ"),
  })
  generateCreditAgreementPdfMock.mockResolvedValue({
    bytes: generatedPdf,
    signatureAnchors: renderedAnchors,
  })
  saveFileToManagedPathMock.mockResolvedValue({
    storagePath: "/agreements/app-1.pdf",
    fileSize: generatedPdf.length,
  })
  deleteManagedFileStrictMock.mockResolvedValue(undefined)
  readFileMock.mockResolvedValue(generatedPdf)
})

afterEach(() => {
  if (ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED === undefined) {
    delete process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  } else {
    process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED = ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  }
  vi.useRealTimers()
})

describe("agreement evidence binding", () => {
  it("does not expose a stale agreement document after generation is invalidated", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      clientId: "client-1",
      agreementGeneratedAt: null,
    })

    const response = await GET(request("GET"), context)

    expect(response.status).toBe(404)
    expect(documentFindFirstMock).not.toHaveBeenCalled()
    expect(documentAccessCreateMock).not.toHaveBeenCalled()
  })

  it("fails closed for a legacy generated agreement without a byte binding", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      clientId: "client-1",
      agreementGeneratedAt: contractStart,
      agreementDocumentId: null,
      agreementDocumentSha256: null,
    })

    const response = await GET(request("GET"), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "legacy_backfill_required",
    }))
    expect(documentFindFirstMock).not.toHaveBeenCalled()
  })

  it("fails closed when the exact application-bound agreement document is missing", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      clientId: "client-1",
      agreementGeneratedAt: contractStart,
      agreementDocumentId: "agreement-doc-1",
      agreementDocumentSha256: generatedPdfSha256,
    })

    const response = await GET(request("GET"), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "document_missing",
    }))
    expect(documentFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: "tenant-1",
        id: "agreement-doc-1",
        clientId: "client-1",
        docType: "CREDIT_AGREEMENT",
        fileName: "credit-agreement-app-1.pdf",
        deletedAt: null,
        storagePath: { not: null },
      }),
    }))
  })

  it("serves only bytes matching the exact application-bound document hash", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      clientId: "client-1",
      agreementGeneratedAt: contractStart,
      agreementDocumentId: "agreement-doc-1",
      agreementDocumentSha256: generatedPdfSha256,
    })
    documentFindFirstMock.mockResolvedValue({
      id: "agreement-doc-1",
      storagePath: "/agreements/app-1.pdf",
      contentSha256: generatedPdfSha256,
    })

    const response = await GET(request("GET"), context)

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(generatedPdf)
    expect(documentAccessCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: "agreement-doc-1",
        action: "view",
      }),
    })
  })

  it("refuses to serve changed agreement bytes", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      clientId: "client-1",
      agreementGeneratedAt: contractStart,
      agreementDocumentId: "agreement-doc-1",
      agreementDocumentSha256: generatedPdfSha256,
    })
    documentFindFirstMock.mockResolvedValue({
      id: "agreement-doc-1",
      storagePath: "/agreements/app-1.pdf",
      contentSha256: generatedPdfSha256,
    })
    readFileMock.mockResolvedValue(Buffer.from("%PDF-1.4 changed"))

    const response = await GET(request("GET"), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "content_mismatch",
    }))
  })

  it("records the initiation-fee election under review in the same transaction as its audit", async () => {
    const updatedAt = new Date("2026-07-18T08:30:00.000Z")
    applicationFindUniqueMock.mockResolvedValue({
      id: "app-1",
      status: "UNDER_REVIEW",
      updatedAt,
      initiationFeePayment: "DEFERRED",
    })

    const response = await PATCH(request("PATCH", { initiationFeePayment: "UPFRONT" }), context)

    expect(response.status).toBe(200)
    expect(txApplicationUpdateManyMock).toHaveBeenCalledWith({
      where: {
        id: "app-1",
        tenantId: "tenant-1",
        status: "UNDER_REVIEW",
        updatedAt,
      },
      data: { initiationFeePayment: "UPFRONT" },
    })
    expect(txAuditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "INITIATION_FEE_ELECTION_RECORDED",
        oldValue: { initiationFeePayment: "DEFERRED" },
        newValue: { initiationFeePayment: "UPFRONT" },
      }),
    })
  })

  it("rejects a post-approval fee election that differs from approved evidence", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)

    const response = await POST(request("POST", { initiationFeePayment: "UPFRONT" }), context)

    expect(response.status).toBe(409)
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
    expect(txDocumentCreateMock).not.toHaveBeenCalled()
    expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
  })

  it("rejects agreement generation when current decision inputs no longer match approval", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    verifyCurrentAffordabilityApprovalMock.mockReturnValue({
      ok: false,
      reason: "changed",
    })

    const response = await POST(request("POST", { initiationFeePayment: "DEFERRED" }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "changed",
    }))
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
    expect(saveFileToManagedPathMock).not.toHaveBeenCalled()
  })

  it("rejects agreement generation without acknowledged credit-life evidence", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...summaryApplication,
      creditLifeDisclosureAcknowledgedAt: null,
    })

    const response = await POST(request("POST", { initiationFeePayment: "DEFERRED" }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      creditLifeEvidence: "missing",
    }))
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
    expect(saveFileToManagedPathMock).not.toHaveBeenCalled()
  })

  it("rejects agreement generation when the bound credit-life evidence was changed", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...summaryApplication,
      creditLifeProductName: "Changed after acknowledgement",
    })

    const response = await POST(request("POST", { initiationFeePayment: "DEFERRED" }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      creditLifeEvidence: "hash_mismatch",
    }))
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
    expect(saveFileToManagedPathMock).not.toHaveBeenCalled()
  })

  it("renders and stores the agreement from the frozen approval pricing and schedule", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)

    const response = await POST(request("POST", { initiationFeePayment: "DEFERRED" }), context)

    expect(response.status).toBe(200)
    expect(bureauCheckFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        applicationId: "app-1",
        clientId: "client-1",
      }),
    }))
    const pdfArgs = generateCreditAgreementPdfMock.mock.calls[0][0]
    expect(pdfArgs.calc).toMatchObject({
      principal: frozenCalculation.principal,
      totalInterest: frozenCalculation.totalInterest,
      initiationFee: frozenCalculation.initiationFee,
      totalRepayable: frozenCalculation.totalRepayable,
    })
    const agreementOffsetMs = contractStart.getTime() - frozenStart.getTime()
    expect(pdfArgs.calc.schedule.map((item: { dueDate: Date }) => item.dueDate.toISOString())).toEqual(
      frozenCalculation.schedule.map((item) =>
        new Date(item.dueDate.getTime() + agreementOffsetMs).toISOString()),
    )
    expect(pdfArgs.startDate.toISOString()).toBe(contractStart.toISOString())
    expect(pdfArgs.maturityDate.toISOString()).toBe(
      new Date(
        frozenCalculation.schedule.at(-1)!.dueDate.getTime()
          + agreementOffsetMs,
      ).toISOString(),
    )
    expect(pdfArgs.application.appliedTermDays).toBe(30)
    expect(pdfArgs.initiationFeePayment).toBe("DEFERRED")
    expect(pdfArgs.willAutoBundleCl).toBe(false)
    expect(quotationValidUntilDateFromDatabaseMock).toHaveBeenCalledWith(
      expect.any(Object),
      frozenStart,
    )
    expect(txComplianceCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        type: "AGREEMENT_ARTIFACT",
        referenceId: "app-1",
        idempotencyKey: "agreement-artifact:tenant-1:app-1",
        status: "PENDING",
        data: expect.objectContaining({
          kind: "CREDIT_AGREEMENT_ARTIFACT",
          lifecycle: "STAGING",
          documentSha256: generatedPdfSha256,
          storagePath: "/agreements/app-1.pdf",
          pasqVersion: "pasq-v3",
          pasqDocumentId: "pasq-doc-1",
          pasqDocumentSha256: "d".repeat(64),
          pasqEvidenceSha256: "e".repeat(64),
          // Where this render put the blank signature rules. Without it,
          // countersignature cannot stamp the stored document and silently
          // falls back to appending an execution page for EVERY loan — a
          // regression no other assertion here would catch.
          signatureAnchors: renderedAnchors,
        }),
      }),
      select: { id: true },
    })
    expect(saveFileToManagedPathMock).toHaveBeenCalledWith(
      generatedPdf,
      "application/pdf",
      expect.stringMatching(/^agreement-/),
    )
    expect(txDocumentCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        clientId: "client-1",
        fileName: "credit-agreement-app-1.pdf",
        storagePath: "/agreements/app-1.pdf",
        contentSha256: generatedPdfSha256,
      }),
    })
    const agreementDocumentId = txDocumentCreateMock.mock.calls[0][0].data.id
    expect(txApplicationUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "app-1",
        tenantId: "tenant-1",
        status: "APPROVED",
        agreementSignedAt: null,
        updatedAt: summaryApplication.updatedAt,
      }),
      data: expect.objectContaining({
        agreementGeneratedAt: contractStart,
        agreementDocumentId,
        agreementDocumentSha256: generatedPdfSha256,
      }),
    }))
    const storedAffordabilityResult =
      txApplicationUpdateManyMock.mock.calls[0][0].data.affordabilityResult
    expect(storedAffordabilityResult.contract).toEqual(expect.objectContaining({
      quotePresentedAt: frozenStart.toISOString(),
      quoteValidUntilDate: "2026-07-27",
    }))
    expect(txComplianceUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "staging-1",
        idempotencyKey: "agreement-artifact:tenant-1:app-1",
        status: "PENDING",
      }),
      data: expect.objectContaining({
        idempotencyKey: null,
        status: "COMPLETED",
        data: expect.objectContaining({
          lifecycle: "COMPLETED",
          creditLifeAutoBundleEligible: false,
        }),
      }),
    }))
    expect(txAuditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "AGREEMENT_GENERATED",
        entityId: "app-1",
        newValue: expect.objectContaining({
          documentId: agreementDocumentId,
          documentSha256: generatedPdfSha256,
          contractEstablishedAt: contractStart.toISOString(),
          contractStartDate: contractStart.toISOString(),
          acceptedPasqContractFingerprint: approval.calculator.contractFingerprint,
          previousDocumentId: null,
          previousDocumentRetained: false,
          creditLifeAutoBundleEligible: false,
          pasqVersion: "pasq-v3",
          pasqDocumentId: "pasq-doc-1",
          pasqDocumentSha256: "d".repeat(64),
          pasqEvidenceSha256: "e".repeat(64),
        }),
      }),
    })
  })

  it("refuses generation before a quotation is issued (quotation_not_issued)", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...summaryApplication,
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
    })

    const response = await POST(
      request("POST", { initiationFeePayment: "DEFERRED" }),
      context,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      ceremonyState: "quotation_not_issued",
    }))
    expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
  })

  it("prepares the agreement from an intact issued PASQ before consumer acknowledgement", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...summaryApplication,
      pasqAcknowledgedAt: null,
      pasqAcknowledgedBy: null,
      pasqAcknowledgedSha256: null,
      approvedPasqDocumentSha256: null,
    })

    const response = await POST(
      request("POST", { initiationFeePayment: "DEFERRED" }),
      context,
    )

    expect(response.status).toBe(200)
    expect(verifyCurrentAffordabilityApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ requirePasqAcknowledgement: false }),
    )
    expect(verifyStoredPasqBindingMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requireAcknowledgement: false }),
    )
  })

  it("refuses generation against a superseded acknowledgement (acknowledgement_stale)", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...summaryApplication,
      // The quotation was re-issued after the consumer acknowledged: the
      // bound document digest moved but the acknowledgement did not.
      pasqDocumentSha256: "1".repeat(64),
    })

    const response = await POST(
      request("POST", { initiationFeePayment: "DEFERRED" }),
      context,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      ceremonyState: "acknowledgement_stale",
    }))
    expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
  })

  it("fails closed when the authoritative business calendar is unavailable", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    quotationValidUntilDateFromDatabaseMock.mockRejectedValue(
      new Error("calendar unavailable"),
    )

    const response = await POST(
      request("POST", { initiationFeePayment: "DEFERRED" }),
      context,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      pasqEvidence: "schedule_or_pricing_changed",
    }))
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
    expect(saveFileToManagedPathMock).not.toHaveBeenCalled()
  })

  it("requires configured statutory provider identity before rendering", async () => {
    tenantFindUniqueMock.mockResolvedValue({
      id: "tenant-1",
      name: "Acme Test",
      config: null,
    })
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)

    const response = await POST(
      request("POST", { initiationFeePayment: "DEFERRED" }),
      context,
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "provider_identity_missing",
    }))
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
  })

  it("cleans staged bytes when statutory provider identity changes before finalization", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    lockProviderIdentityMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await POST(
      request("POST", { initiationFeePayment: "DEFERRED" }),
      context,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "provider_identity_changed",
    }))
    expect(deleteManagedFileStrictMock).toHaveBeenCalledWith(
      "/agreements/app-1.pdf",
    )
    expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
  })

  it("renders the existing credit-life disclosure only when auto-bundling is explicitly enabled", async () => {
    process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED = "true"
    const acceptedDisclosure = {
      ...creditLifeDisclosure,
      election: "ACCEPTED" as const,
    }
    applicationFindUniqueMock.mockResolvedValue({
      ...summaryApplication,
      creditLifeElection: "ACCEPTED",
      creditLifeDisclosureSha256:
        createCreditLifeDisclosureSha256(acceptedDisclosure),
    })
    verifyStoredPasqBindingMock.mockReturnValue({
      ok: true,
      documentId: "pasq-doc-1",
      documentSha256: "d".repeat(64),
      evidence: {
        version: "pasq-v3",
        evidenceSha256: "e".repeat(64),
        totalCostOfCreditCents: 617_250,
        calculator: approval.calculator,
        creditLife: {
          premiumPeriods: 1,
          totalPremiumCents: 2_250,
        },
        billing: {
          recurringPaymentCents: frozenCalculation.monthlyInstalment + 2_250,
          totalRepayableCents: frozenCalculation.totalRepayable + 2_250,
          schedule: [],
        },
      },
    })

    const response = await POST(request("POST", { initiationFeePayment: "DEFERRED" }), context)

    expect(response.status).toBe(200)
    expect(generateCreditAgreementPdfMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      willAutoBundleCl: true,
      creditLife: {
        elected: true,
        productName: creditLifeDisclosure.productName,
        insurerName: creditLifeDisclosure.insurerName,
        monthlyPremiumCents: 2_250,
        premiumPeriods: 1,
        totalPremiumCents: 2_250,
        billing: expect.any(Object),
      },
    }))
    expect(txComplianceCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        data: expect.objectContaining({
          creditLifeAutoBundleEligible: true,
          creditLifeElection: "ACCEPTED",
          creditLifeProductId: creditLifeDisclosure.productId,
          creditLifeProductName: creditLifeDisclosure.productName,
          creditLifeInsurerId: creditLifeDisclosure.insurerId,
          creditLifeInsurerName: creditLifeDisclosure.insurerName,
          creditLifeMonthlyPremiumCents: 2_250,
          creditLifeDisclosureVersion: creditLifeDisclosure.version,
          creditLifeDisclosureSha256: createCreditLifeDisclosureSha256(
            acceptedDisclosure,
          ),
        }),
      }),
      select: { id: true },
    })
  })

  it("rejects agreement generation when the approval PASQ binding changed", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    verifyStoredPasqBindingMock.mockReturnValue({
      ok: false,
      reason: "approval_binding_missing",
    })

    const response = await POST(request("POST", { initiationFeePayment: "DEFERRED" }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "pasq_changed",
      pasqEvidence: "approval_binding_missing",
    }))
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
  })

  it("rejects agreement generation when the approved PASQ bytes are tampered", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    verifyPasqDocumentArtifactMock.mockResolvedValue({
      ok: false,
      reason: "hash_mismatch",
    })

    const response = await POST(request("POST", { initiationFeePayment: "DEFERRED" }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "pasq_changed",
      pasqDocument: "hash_mismatch",
    }))
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
  })

  it("does not silently turn an accepted election into an agreement without cover", async () => {
    const acceptedDisclosure = {
      ...creditLifeDisclosure,
      election: "ACCEPTED" as const,
    }
    applicationFindUniqueMock.mockResolvedValue({
      ...summaryApplication,
      creditLifeElection: "ACCEPTED",
      creditLifeDisclosureSha256:
        createCreditLifeDisclosureSha256(acceptedDisclosure),
    })

    const response = await POST(request("POST", { initiationFeePayment: "DEFERRED" }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      creditLifeEvidence: "availability_changed",
    }))
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
    expect(saveFileToManagedPathMock).not.toHaveBeenCalled()
  })

  it("rejects an accepted legal agreement when the exact product or insurer is inactive", async () => {
    process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED = "true"
    const acceptedDisclosure = {
      ...creditLifeDisclosure,
      election: "ACCEPTED" as const,
    }
    applicationFindUniqueMock.mockResolvedValue({
      ...summaryApplication,
      creditLifeElection: "ACCEPTED",
      creditLifeDisclosureSha256:
        createCreditLifeDisclosureSha256(acceptedDisclosure),
    })
    insuranceProductFindFirstMock.mockResolvedValue(null)

    const response = await POST(
      request("POST", { initiationFeePayment: "DEFERRED" }),
      context,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      creditLifeEvidence: "availability_changed",
    }))
    expect(insuranceProductFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: creditLifeDisclosure.productId,
          tenantId: "tenant-1",
          name: creditLifeDisclosure.productName,
          type: "CREDIT_LIFE",
          active: true,
          insurer: {
            is: {
              id: creditLifeDisclosure.insurerId,
              tenantId: "tenant-1",
              name: creditLifeDisclosure.insurerName,
              active: true,
            },
          },
        }),
      }),
    )
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
    expect(txComplianceCreateMock).not.toHaveBeenCalled()
  })

  it("aborts and cleans staged bytes if an accepted offer deactivates before final binding", async () => {
    process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED = "true"
    const acceptedDisclosure = {
      ...creditLifeDisclosure,
      election: "ACCEPTED" as const,
    }
    const acceptedApplication = {
      ...summaryApplication,
      creditLifeElection: "ACCEPTED",
      creditLifeDisclosureSha256:
        createCreditLifeDisclosureSha256(acceptedDisclosure),
    }
    applicationFindUniqueMock.mockResolvedValue(acceptedApplication)
    verifyLockedCurrentAffordabilityApprovalMock.mockResolvedValue({
      ok: true,
      application: acceptedApplication,
      approval,
      calculation: frozenCalculation,
    })
    let offerLockCount = 0
    txQueryRawMock.mockImplementation((query: { strings?: readonly string[] }) => {
      const sql = query?.strings?.join(" ") ?? String(query)
      if (sql.includes('FROM "InsuranceProduct"')) {
        offerLockCount += 1
        return Promise.resolve(
          offerLockCount === 1
            ? [{ id: creditLifeDisclosure.productId }]
            : [],
        )
      }
      return Promise.resolve([{ id: "staging-1" }])
    })

    const response = await POST(
      request("POST", { initiationFeePayment: "DEFERRED" }),
      context,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      creditLifeEvidence: "availability_changed",
      agreementIntegrity: "staging_failed",
    }))
    expect(deleteManagedFileStrictMock).toHaveBeenCalledWith(
      "/agreements/app-1.pdf",
    )
    expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
    const offerLockSql = txQueryRawMock.mock.calls
      .map(([query]) => {
        const sql = query as { strings?: readonly string[] }
        return sql.strings?.join(" ") ?? String(query)
      })
      .filter((sql) => sql.includes('FROM "InsuranceProduct"'))
      .join("\n")
    expect(offerLockSql).toContain(
      `product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"`,
    )
    expect(offerLockSql).toContain(`product."active" = TRUE`)
    expect(offerLockSql).toContain(`insurer."active" = TRUE`)
    expect(offerLockSql).toContain(`FOR SHARE OF product, insurer`)
  })

  it("returns an already-generated unsigned agreement idempotently", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...summaryApplication,
      agreementGeneratedAt: contractStart,
      agreementDocumentId: "agreement-doc-existing",
      agreementDocumentSha256: generatedPdfSha256,
    })
    documentFindFirstMock.mockResolvedValue({
      id: "agreement-doc-existing",
      clientId: "client-1",
      storagePath: "/agreements/existing.pdf",
      contentSha256: generatedPdfSha256,
    })
    auditFindFirstMock.mockResolvedValue({ id: "audit-generation" })

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expect.objectContaining({ id: "agreement-doc-existing" }))
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
    expect(txComplianceCreateMock).not.toHaveBeenCalled()
    expect(saveFileToManagedPathMock).not.toHaveBeenCalled()
  })

  it("regenerates an unsigned agreement on explicit request: new artifact, old draft retired", async () => {
    const regenApplication = {
      ...summaryApplication,
      agreementGeneratedAt: contractStart,
      agreementDocumentId: "agreement-doc-existing",
      agreementDocumentSha256: generatedPdfSha256,
    }
    applicationFindUniqueMock.mockResolvedValue(regenApplication)
    // Entry verification of the artifact being superseded.
    documentFindFirstMock.mockResolvedValueOnce({
      id: "agreement-doc-existing",
      clientId: "client-1",
      storagePath: "/agreements/existing.pdf",
      contentSha256: generatedPdfSha256,
    })
    auditFindFirstMock.mockResolvedValueOnce({ id: "audit-generation" })
    // The locked re-checks must see the SAME anchor this request read.
    verifyLockedCurrentAffordabilityApprovalMock.mockResolvedValue({
      ok: true,
      application: regenApplication,
      approval,
      calculation: frozenCalculation,
    })

    const response = await POST(request("POST", { regenerate: true }), context)

    expect(response.status).toBe(200)
    expect(generateCreditAgreementPdfMock).toHaveBeenCalled()
    // The superseded draft is retired in the same transaction, never deleted.
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "agreement-doc-existing",
        docType: "CREDIT_AGREEMENT",
        contentSha256: generatedPdfSha256,
        deletedAt: null,
      }),
      data: expect.objectContaining({ deletedAt: expect.any(Date) }),
    }))
    expect(txAuditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "AGREEMENT_GENERATED",
        newValue: expect.objectContaining({
          previousDocumentId: "agreement-doc-existing",
          previousDocumentSha256: generatedPdfSha256,
          previousDocumentRetained: true,
        }),
      }),
    })
  })

  it("aborts the regeneration when the superseded draft vanished mid-transaction", async () => {
    const regenApplication = {
      ...summaryApplication,
      agreementGeneratedAt: contractStart,
      agreementDocumentId: "agreement-doc-existing",
      agreementDocumentSha256: generatedPdfSha256,
    }
    applicationFindUniqueMock.mockResolvedValue(regenApplication)
    documentFindFirstMock.mockResolvedValueOnce({
      id: "agreement-doc-existing",
      clientId: "client-1",
      storagePath: "/agreements/existing.pdf",
      contentSha256: generatedPdfSha256,
    })
    auditFindFirstMock.mockResolvedValueOnce({ id: "audit-generation" })
    verifyLockedCurrentAffordabilityApprovalMock.mockResolvedValue({
      ok: true,
      application: regenApplication,
      approval,
      calculation: frozenCalculation,
    })
    // A concurrent writer already retired or replaced the draft. The abort
    // must THROW (a return from an interactive transaction COMMITS) so the
    // whole write — new binding included — rolls back before the caller
    // cleans the staged bytes.
    txDocumentUpdateManyMock.mockResolvedValue({ count: 0 })

    const response = await POST(request("POST", { regenerate: true }), context)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "staging_failed",
    }))
    expect(deleteManagedFileStrictMock).toHaveBeenCalledWith("/agreements/app-1.pdf")
  })

  it("aborts staging when the anchor moved between entry read and lock (regeneration)", async () => {
    const regenApplication = {
      ...summaryApplication,
      agreementGeneratedAt: contractStart,
      agreementDocumentId: "agreement-doc-existing",
      agreementDocumentSha256: generatedPdfSha256,
    }
    applicationFindUniqueMock.mockResolvedValue(regenApplication)
    documentFindFirstMock.mockResolvedValueOnce({
      id: "agreement-doc-existing",
      clientId: "client-1",
      storagePath: "/agreements/existing.pdf",
      contentSha256: generatedPdfSha256,
    })
    auditFindFirstMock.mockResolvedValueOnce({ id: "audit-generation" })
    // Under the lock the anchor is a DIFFERENT artifact — a concurrent
    // regeneration won the race. Inverting agreementAnchorMoved's
    // regeneration branch to `false` turns this test RED.
    verifyLockedCurrentAffordabilityApprovalMock.mockResolvedValue({
      ok: true,
      application: {
        ...regenApplication,
        agreementDocumentSha256: "9".repeat(64),
      },
      approval,
      calculation: frozenCalculation,
    })

    const response = await POST(request("POST", { regenerate: true }), context)

    expect(response.status).toBe(409)
    // The PDF renders before staging; the abort shows in the staging tx
    // never creating the artifact ledger record, and nothing downstream.
    expect(txComplianceCreateMock).not.toHaveBeenCalled()
    expect(txDocumentUpdateManyMock).not.toHaveBeenCalled()
    expect(saveFileToManagedPathMock).not.toHaveBeenCalled()
  })

  it("the pre-existing signed-immutability guard also refuses regeneration", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...summaryApplication,
      agreementGeneratedAt: contractStart,
      agreementDocumentId: "agreement-doc-existing",
      agreementDocumentSha256: generatedPdfSha256,
      agreementSignedAt: contractStart,
    })
    // No document/audit mocks: the pre-existing signed-immutability guard
    // fires before the artifact is ever looked up. The regenerate-specific
    // already_signed 409 in the route is defence-in-depth behind it.

    const response = await POST(request("POST", { regenerate: true }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      error: expect.stringMatching(/signed agreement is immutable/i),
    }))
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
    expect(txDocumentUpdateManyMock).not.toHaveBeenCalled()
  })

  it("a plain POST (no regenerate flag) still returns the existing agreement idempotently", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...summaryApplication,
      agreementGeneratedAt: contractStart,
      agreementDocumentId: "agreement-doc-existing",
      agreementDocumentSha256: generatedPdfSha256,
    })
    documentFindFirstMock.mockResolvedValueOnce({
      id: "agreement-doc-existing",
      clientId: "client-1",
      storagePath: "/agreements/existing.pdf",
      contentSha256: generatedPdfSha256,
    })
    auditFindFirstMock.mockResolvedValueOnce({ id: "audit-generation" })

    const response = await POST(request("POST", {}), context)

    expect(response.status).toBe(200)
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
    expect(txDocumentUpdateManyMock).not.toHaveBeenCalled()
  })

  it("does not record an agreement when managed storage changes the generated bytes", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    readFileMock.mockResolvedValue(Buffer.from("%PDF-1.4 corrupted write"))

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(500)
    expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
    expect(txDocumentCreateMock).not.toHaveBeenCalled()
    expect(txAuditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "AGREEMENT_ARTIFACT_STAGED" }),
    })
    expect(txAuditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "AGREEMENT_ARTIFACT_STAGING_FAILED" }),
    })
    expect(deleteManagedFileStrictMock).toHaveBeenCalledWith("/agreements/app-1.pdf")
  })

  it("strictly removes staged bytes and returns 409 when the application changes before commit", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    txApplicationUpdateManyMock.mockResolvedValue({ count: 0 })

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(409)
    expect(txDocumentCreateMock).not.toHaveBeenCalled()
    expect(txAuditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "AGREEMENT_ARTIFACT_STAGING_FAILED" }),
    })
    expect(deleteManagedFileStrictMock).toHaveBeenCalledWith("/agreements/app-1.pdf")
  })

  it("does not delete a committed artifact when the transaction acknowledgement is lost", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    transactionMock
      .mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => callback({
        $queryRaw: (...args: unknown[]) => txQueryRawMock(...args),
        loanApplication: { updateMany: txApplicationUpdateManyMock },
        clientDocument: { create: txDocumentCreateMock },
        complianceRecord: {
          create: txComplianceCreateMock,
          updateMany: txComplianceUpdateManyMock,
        },
        auditLog: { create: txAuditCreateMock },
      }))
      .mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => callback({
        $queryRaw: (...args: unknown[]) => txQueryRawMock(...args),
        loanApplication: { updateMany: txApplicationUpdateManyMock },
        clientDocument: { create: txDocumentCreateMock },
        complianceRecord: {
          create: txComplianceCreateMock,
          updateMany: txComplianceUpdateManyMock,
        },
        auditLog: { create: txAuditCreateMock },
      }))
      .mockRejectedValueOnce(new Error("commit acknowledgement lost"))
    documentFindFirstMock.mockResolvedValue({
      id: "agreement-doc-committed",
      clientId: "client-1",
      storagePath: "/agreements/app-1.pdf",
      contentSha256: generatedPdfSha256,
    })
    auditFindFirstMock.mockResolvedValue({ id: "audit-generated" })

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expect.objectContaining({
      id: "agreement-doc-committed",
    }))
    expect(deleteManagedFileStrictMock).not.toHaveBeenCalled()
  })

  it("retains indexed staged bytes when the commit outcome cannot be resolved", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    transactionMock
      .mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => callback({
        $queryRaw: (...args: unknown[]) => txQueryRawMock(...args),
        loanApplication: { updateMany: txApplicationUpdateManyMock },
        clientDocument: { create: txDocumentCreateMock },
        complianceRecord: {
          create: txComplianceCreateMock,
          updateMany: txComplianceUpdateManyMock,
        },
        auditLog: { create: txAuditCreateMock },
      }))
      .mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => callback({
        $queryRaw: (...args: unknown[]) => txQueryRawMock(...args),
        loanApplication: { updateMany: txApplicationUpdateManyMock },
        clientDocument: { create: txDocumentCreateMock },
        complianceRecord: {
          create: txComplianceCreateMock,
          updateMany: txComplianceUpdateManyMock,
        },
        auditLog: { create: txAuditCreateMock },
      }))
      .mockRejectedValueOnce(new Error("commit acknowledgement lost"))
    documentFindFirstMock.mockRejectedValueOnce(new Error("database unavailable"))

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "commit_outcome_unknown",
    }))
    expect(txComplianceCreateMock).toHaveBeenCalledOnce()
    expect(deleteManagedFileStrictMock).not.toHaveBeenCalled()
  })

  it("blocks a concurrent active staging lease before rendering or writing another PDF", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    complianceFindUniqueMock.mockResolvedValue({
      id: "staging-existing",
      tenantId: "tenant-1",
      status: "PENDING",
      createdAt: new Date(),
      data: {
        kind: "CREDIT_AGREEMENT_ARTIFACT",
        lifecycle: "STAGING",
        applicationId: "app-1",
        documentId: "doc-existing",
        documentSha256: generatedPdfSha256,
        storagePath: "/agreements/app-1.pdf",
        fileName: "credit-agreement-app-1.pdf",
        fileSize: generatedPdf.length,
        stagedAt: new Date().toISOString(),
      },
    })

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "staging_in_progress",
    }))
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
    expect(saveFileToManagedPathMock).not.toHaveBeenCalled()
  })

  it("fails closed when an expired staged artifact cannot be deleted strictly", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    complianceFindUniqueMock.mockResolvedValue({
      id: "staging-expired",
      tenantId: "tenant-1",
      status: "PENDING",
      createdAt: new Date("2026-07-19T08:00:00.000Z"),
      data: {
        kind: "CREDIT_AGREEMENT_ARTIFACT",
        lifecycle: "STAGING",
        applicationId: "app-1",
        documentId: "doc-expired",
        documentSha256: generatedPdfSha256,
        storagePath: "/agreements/app-1.pdf",
        fileName: "credit-agreement-app-1.pdf",
        fileSize: generatedPdf.length,
        stagedAt: "2026-07-19T08:00:00.000Z",
      },
    })
    deleteManagedFileStrictMock.mockRejectedValueOnce(new Error("permission denied"))

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "staging_reconciliation_required",
    }))
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
    expect(txComplianceCreateMock).not.toHaveBeenCalled()
  })

  it("resumes an interrupted RECONCILING cleanup and generates a fresh artifact", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    complianceFindUniqueMock.mockResolvedValue({
      id: "staging-reconciling",
      tenantId: "tenant-1",
      status: "PENDING",
      createdAt: new Date("2026-07-19T08:00:00.000Z"),
      data: {
        kind: "CREDIT_AGREEMENT_ARTIFACT",
        lifecycle: "RECONCILING",
        applicationId: "app-1",
        documentId: "doc-abandoned",
        documentSha256: generatedPdfSha256,
        storagePath: "/agreements/app-1-abandoned.pdf",
        fileName: "credit-agreement-app-1.pdf",
        fileSize: generatedPdf.length,
        stagedAt: "2026-07-19T08:00:00.000Z",
      },
    })

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(200)
    expect(deleteManagedFileStrictMock).toHaveBeenCalledWith("/agreements/app-1-abandoned.pdf")
    expect(txComplianceUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "staging-reconciling",
        status: "PENDING",
        data: { path: ["lifecycle"], equals: "RECONCILING" },
      }),
      data: expect.objectContaining({
        idempotencyKey: null,
        status: "COMPLETED",
        data: expect.objectContaining({
          lifecycle: "FAILED",
          failureReason: "Resumed cleanup of an interrupted agreement-artifact reconciliation before retry.",
        }),
      }),
    }))
    expect(txComplianceCreateMock).toHaveBeenCalledOnce()
    expect(generateCreditAgreementPdfMock).toHaveBeenCalledOnce()
    expect(saveFileToManagedPathMock).toHaveBeenCalledOnce()
  })

  it("rechecks locked affordability evidence before recording the generated agreement", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    verifyLockedCurrentAffordabilityApprovalMock.mockResolvedValue({
      ok: false,
      reason: "changed",
    })

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      affordabilitySnapshot: "changed",
    }))
    expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
    expect(txDocumentCreateMock).not.toHaveBeenCalled()
    expect(txAuditCreateMock).not.toHaveBeenCalled()
    expect(txComplianceCreateMock).not.toHaveBeenCalled()
    expect(saveFileToManagedPathMock).not.toHaveBeenCalled()
    expect(deleteManagedFileStrictMock).not.toHaveBeenCalled()
  })

  it("returns a distinct remediation when composite KYC changes before generation", async () => {
    applicationFindUniqueMock.mockResolvedValue(summaryApplication)
    verifyLockedCurrentAffordabilityApprovalMock.mockResolvedValue({
      ok: false,
      reason: "kyc_changed",
    })

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "kyc_changed",
      remediation: expect.stringMatching(/capture a selfie or record an in-person verification/i),
    }))
    expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
    expect(txDocumentCreateMock).not.toHaveBeenCalled()
    expect(saveFileToManagedPathMock).not.toHaveBeenCalled()
  })

  it("never replaces a signed agreement", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...summaryApplication,
      agreementSignedAt: new Date("2026-07-20T09:30:00.000Z"),
    })

    const response = await POST(request("POST"), context)

    expect(response.status).toBe(409)
    expect(generateCreditAgreementPdfMock).not.toHaveBeenCalled()
    expect(saveFileToManagedPathMock).not.toHaveBeenCalled()
  })
})
