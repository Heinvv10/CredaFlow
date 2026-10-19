import { CREDIT_LIFE_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { parseLenderIdentity } from "@/lib/config/identity"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { createDebitMandateTestEvidence } from "@/lib/loan/__fixtures__/debit-mandate"
import { createPasqEvidence } from "@/lib/compliance/pasq"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { createAffordabilityContractEvidence } from "@/lib/affordability/snapshot"

const {
  requireApiRoleMock,
  userFindUniqueMock,
  getDefaultTenantIdMock,
  loanFindUniqueMock,
  lenderIdentityMock,
  generateDebitMandatePdfMock,
  getDebitMandateCreditorBankDetailsMock,
  assertDebitMandateCreditorTenantMock,
  DebitMandateConfigurationErrorMock,
  documentAccessCreateMock,
} = vi.hoisted(() => ({
  requireApiRoleMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  getDefaultTenantIdMock: vi.fn(),
  loanFindUniqueMock: vi.fn(),
  lenderIdentityMock: vi.fn(),
  generateDebitMandatePdfMock: vi.fn(),
  getDebitMandateCreditorBankDetailsMock: vi.fn(),
  assertDebitMandateCreditorTenantMock: vi.fn(),
  DebitMandateConfigurationErrorMock: class DebitMandateConfigurationError extends Error {},
  documentAccessCreateMock: vi.fn(),
}))

// No tenant logo: documents print the text letterhead (lib/config/lender-logo.ts).
vi.mock("@/lib/config/lender-logo", () => ({ getLenderLogo: async () => undefined }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  getDefaultTenantId: (...args: unknown[]) => getDefaultTenantIdMock(...args),
  withTenantContext: (_req: unknown, callback: (tenant: { id: string; slug: string }) => unknown) =>
    callback({ id: "tenant-1", slug: "acme" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => userFindUniqueMock(...args) },
    loan: { findUnique: (...args: unknown[]) => loanFindUniqueMock(...args) },
    documentAccessLog: { create: (...args: unknown[]) => documentAccessCreateMock(...args) },
  },
}))
vi.mock("@/lib/config/identity-response", () => ({
  lenderIdentityOrRefusal: (...args: unknown[]) => lenderIdentityMock(...args),
}))
vi.mock("@/lib/pdf/debitMandate", () => ({
  generateDebitMandatePdf: (...args: unknown[]) => generateDebitMandatePdfMock(...args),
}))
vi.mock("@/lib/config/debit-mandate", () => ({
  assertDebitMandateCreditorTenant: (...args: unknown[]) =>
    assertDebitMandateCreditorTenantMock(...args),
  DebitMandateConfigurationError: DebitMandateConfigurationErrorMock,
  getDebitMandateCreditorBankDetails: (...args: unknown[]) =>
    getDebitMandateCreditorBankDetailsMock(...args),
}))

import { GET } from "./route"

const request = new NextRequest("https://staging.example.test/api/loans/loan-1/debit-mandate", {
  headers: {
    "x-forwarded-for": "192.0.2.10, 198.51.100.2",
    "user-agent": "mandate-test-agent",
  },
})
const context = { params: Promise.resolve({ id: "loan-1" }) }

const evidence = createDebitMandateTestEvidence()
const loan = {
  id: "loan-1",
  tenantId: "tenant-1",
  reference: "LN-TEST-1",
  principal: evidence.calculation.principal,
  totalInterest: evidence.calculation.totalInterest,
  initiationFee: evidence.calculation.initiationFee,
  totalRepayable: evidence.calculation.totalRepayable,
  startDate: evidence.startDate,
  maturityDate: evidence.maturityDate,
  client: {
    firstName: "Synthetic",
    lastName: "Customer",
    idNumber: "9001015000086",
    phone: "0820000000",
    email: "synthetic@example.test",
    bankName: "Test Bank",
    bankBranchCode: "000001",
    bankAccountNumber: "1234567890",
    accountType: "CHEQUE",
  },
  application: {
    id: "application-1",
    clientId: "client-1",
    productId: "debit-mandate-test-product",
    initiationFeePayment: evidence.initiationFeePayment,
    affordabilityResult: evidence.affordabilityResult,
    creditLifeDisclosureSha256: null,
    pasqVersion: null,
  },
  repaymentSchedule: evidence.schedule,
}

beforeEach(() => {
  vi.stubEnv("TRUSTED_PROXY", "1")
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "staff-1" } })
  userFindUniqueMock.mockResolvedValue({ active: true, tenantId: "tenant-1" })
  getDefaultTenantIdMock.mockResolvedValue("tenant-1")
  loanFindUniqueMock.mockResolvedValue(loan)
  lenderIdentityMock.mockResolvedValue({ identity: parseLenderIdentity(VALID_LENDER_COLUMNS) })
  generateDebitMandatePdfMock.mockResolvedValue(Buffer.from("%PDF-draft"))
  getDebitMandateCreditorBankDetailsMock.mockReturnValue({
    bankName: "Provider Bank",
    accountNumber: "9876543210",
    branchCode: "250655",
  })
  documentAccessCreateMock.mockResolvedValue({ id: "access-1" })
})

afterEach(() => vi.unstubAllEnvs())

describe("GET /api/loans/[id]/debit-mandate", () => {
  it("refuses with 409 and renders nothing when the lender identity is not configured", async () => {
    lenderIdentityMock.mockResolvedValue({
      refusal: NextResponse.json({ code: "LENDER_IDENTITY_NOT_CONFIGURED" }, { status: 409 }),
    })
    const response = await GET(request, context)
    expect(response.status).toBe(409)
    expect(generateDebitMandatePdfMock).not.toHaveBeenCalled()
  })

  it("renders a draft with the recurring debit, itemised first debit, and on-file banking", async () => {
    const response = await GET(request, context)

    expect(response.status).toBe(200)
    expect(response.headers.get("x-document-state")).toBe("DRAFT")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("content-disposition")).toContain("DebitMandate-DRAFT-LN-TEST-1.pdf")
    expect(loanFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "loan-1", tenantId: "tenant-1" },
      include: expect.objectContaining({
        application: {
          select: {
            id: true,
            clientId: true,
            productId: true,
            initiationFeePayment: true,
            affordabilityResult: true,
            creditLifeDisclosureSha256: true,
            pasqVersion: true,
            pasqGeneratedAt: true,
            pasqDocumentId: true,
            pasqDocumentSha256: true,
            pasqEvidence: true,
            pasqEvidenceSha256: true,
            pasqAcknowledgedAt: true,
            pasqAcknowledgedBy: true,
            pasqAcknowledgedSha256: true,
            approvedPasqDocumentSha256: true,
          },
        },
        repaymentSchedule: expect.objectContaining({
          orderBy: { installmentNo: "asc" },
          select: {
            installmentNo: true,
            dueDate: true,
            principalDue: true,
            interestDue: true,
            feesDue: true,
            totalDue: true,
          },
        }),
      }),
    }))
    expect(userFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "staff-1" },
      select: { active: true, tenantId: true },
    })
    expect(assertDebitMandateCreditorTenantMock).toHaveBeenCalledWith("tenant-1")
    expect(generateDebitMandatePdfMock).toHaveBeenCalledWith(expect.objectContaining({
      lender: expect.objectContaining({
        legalName: "Acme Lending (Pty) Ltd",
        ncrNumber: "NCRCP99999",
        registeredOfficeLines: ["1 Main Road", "Sandton", "2196"],
      }),
      creditorBank: {
        bankName: "Provider Bank",
        accountNumber: "9876543210",
        branchCode: "250655",
      },
      client: expect.objectContaining({
        bankName: "Test Bank",
        branchCode: "000001",
        accountNumber: "1234567890",
        accountType: "CHEQUE",
      }),
      loan: {
        reference: "LN-TEST-1",
        paymentFrequency: "MONTHLY",
        recurringDebitAmount: evidence.calculation.schedule[1].totalDue,
        firstDebitAmount: evidence.calculation.schedule[0].totalDue,
        firstDebitInitiationFee: evidence.calculation.initiationFee,
        firstDebitDate: evidence.calculation.schedule[0].dueDate,
        repaymentDayOfMonth: 1,
      },
    }))
    expect(documentAccessCreateMock).toHaveBeenCalledWith({
      data: {
        documentId: "loan-1",
        accessorType: "staff",
        accessorId: "staff-1",
        action: "view_draft",
        ipAddress: "198.51.100.2",
        userAgent: "mandate-test-agent",
      },
    })
  })

  it("renders a premium-inclusive PASQ v3 booked schedule", async () => {
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
    const creditLifeDisclosureSha256 =
      createCreditLifeDisclosureSha256(creditLife)
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
        disclosureSha256: creditLifeDisclosureSha256,
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
    const bookedSchedule = pasqEvidence.billing.schedule.map((item) => ({
      installmentNo: item.installmentNo,
      dueDate: new Date(new Date(item.dueDate).getTime() + agreementOffsetMs),
      principalDue: item.principalDueCents,
      interestDue: item.interestDueCents,
      feesDue: item.feesDueCents,
      totalDue: item.totalDueCents,
    }))
    loanFindUniqueMock.mockResolvedValue({
      ...loan,
      totalRepayable: pasqEvidence.billing.totalRepayableCents,
      startDate: new Date(evidence.startDate.getTime() + fundingOffsetMs),
      maturityDate: bookedSchedule.at(-1)!.dueDate,
      application: {
        ...loan.application,
        affordabilityResult: {
          ...evidence.affordabilityResult,
          contract,
        },
        creditLifeDisclosureSha256,
        pasqVersion: pasqEvidence.version,
        pasqGeneratedAt: evidence.startDate,
        pasqDocumentId: "pasq-document-1",
        pasqDocumentSha256: "d".repeat(64),
        pasqEvidence,
        pasqEvidenceSha256: pasqEvidence.evidenceSha256,
        pasqAcknowledgedAt: new Date(evidence.startDate.getTime() + 1_000),
        pasqAcknowledgedBy: "client-1",
        pasqAcknowledgedSha256: "d".repeat(64),
        approvedPasqDocumentSha256: "d".repeat(64),
      },
      repaymentSchedule: bookedSchedule,
    })

    const response = await GET(request, context)

    expect(response.status).toBe(200)
    expect(generateDebitMandatePdfMock).toHaveBeenCalledWith(
      expect.objectContaining({
        loan: expect.objectContaining({
          firstDebitAmount:
            pasqEvidence.billing.schedule[0].totalDueCents,
          recurringDebitAmount:
            pasqEvidence.billing.schedule[1].totalDueCents,
        }),
      }),
    )
  })

  it("returns 422 instead of generating a mandate with blank banking fields", async () => {
    loanFindUniqueMock.mockResolvedValue({
      ...loan,
      client: { ...loan.client, bankAccountNumber: null },
    })

    const response = await GET(request, context)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({
      error: "Complete on-file banking details are required before generating a debit mandate.",
    })
    expect(generateDebitMandatePdfMock).not.toHaveBeenCalled()
    expect(documentAccessCreateMock).not.toHaveBeenCalled()
  })

  it("forbids a staff principal from selecting another tenant", async () => {
    userFindUniqueMock.mockResolvedValueOnce({ active: true, tenantId: "tenant-other" })

    const response = await GET(request, context)

    expect(response.status).toBe(403)
    expect(loanFindUniqueMock).not.toHaveBeenCalled()
    expect(generateDebitMandatePdfMock).not.toHaveBeenCalled()
    expect(documentAccessCreateMock).not.toHaveBeenCalled()
  })

  it("refuses tenantless staff instead of binding them to the default tenant", async () => {
    userFindUniqueMock.mockResolvedValueOnce({ active: true, tenantId: null })
    // Even when the default tenant equals the request tenant, no fallback.
    getDefaultTenantIdMock.mockResolvedValue("tenant-1")

    const response = await GET(request, context)

    expect(response.status).toBe(403)
    expect(getDefaultTenantIdMock).not.toHaveBeenCalled()
    expect(loanFindUniqueMock).not.toHaveBeenCalled()
  })

  it("returns 422 instead of printing a zero amount when the schedule is missing", async () => {
    loanFindUniqueMock.mockResolvedValue({ ...loan, repaymentSchedule: [] })

    const response = await GET(request, context)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({
      error: "A complete repayment schedule is required before generating a debit mandate.",
    })
    expect(generateDebitMandatePdfMock).not.toHaveBeenCalled()
    expect(documentAccessCreateMock).not.toHaveBeenCalled()
  })

  it("returns 503 instead of printing placeholder creditor banking", async () => {
    getDebitMandateCreditorBankDetailsMock.mockImplementationOnce(() => {
      throw new DebitMandateConfigurationErrorMock(
        "Debit-mandate creditor banking is not configured.",
      )
    })

    const response = await GET(request, context)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: "Debit-mandate creditor banking is not configured.",
    })
    expect(generateDebitMandatePdfMock).not.toHaveBeenCalled()
    expect(documentAccessCreateMock).not.toHaveBeenCalled()
  })

  it("returns 503 instead of applying the global creditor identity to another tenant", async () => {
    assertDebitMandateCreditorTenantMock.mockImplementationOnce(() => {
      throw new DebitMandateConfigurationErrorMock(
        "Debit-mandate creditor identity is not configured for this tenant.",
      )
    })

    const response = await GET(request, context)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: "Debit-mandate creditor identity is not configured for this tenant.",
    })
    expect(generateDebitMandatePdfMock).not.toHaveBeenCalled()
    expect(documentAccessCreateMock).not.toHaveBeenCalled()
  })

  it("fails closed when the POPIA access row cannot be written", async () => {
    documentAccessCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

    await expect(GET(request, context)).rejects.toThrow("audit unavailable")
  })
})
