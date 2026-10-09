import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { parseLenderIdentity } from "@/lib/config/identity"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"

const {
  requireApiRoleMock,
  loanFindUniqueMock,
  lenderIdentityMock,
  generatePdfMock,
  documentAccessCreateMock,
} = vi.hoisted(() => ({
  requireApiRoleMock: vi.fn(),
  loanFindUniqueMock: vi.fn(),
  lenderIdentityMock: vi.fn(),
  generatePdfMock: vi.fn(),
  documentAccessCreateMock: vi.fn(),
}))

// No tenant logo: documents print the text letterhead (lib/config/lender-logo.ts).
vi.mock("@/lib/config/lender-logo", () => ({ getLenderLogo: async () => undefined }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, callback: (tenant: { id: string; name: string }) => unknown) =>
    callback({ id: "tenant-1", name: "Acme Lending" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findUnique: (...args: unknown[]) => loanFindUniqueMock(...args) },
    documentAccessLog: { create: (...args: unknown[]) => documentAccessCreateMock(...args) },
  },
}))
// Default-charge figures are exercised in lib/loan/charges-summary.test.ts and
// against real Postgres; here they are the no-charges case.
const { settlementFiguresMock } = vi.hoisted(() => ({ settlementFiguresMock: vi.fn() }))
vi.mock("@/lib/loan/charges-summary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loan/charges-summary")>()),
  loanSettlementFigures: (...args: unknown[]) => settlementFiguresMock(...args),
}))
const figures = (live: boolean) => ({
  live, charges: live ? {} : null, chargeLines: live ? [{ label: "Default interest", amount: 8_000 }] : [],
  chargesOutstanding: live ? 8_000 : 0, totalToSettle: 205_514,
  interestAndFeesOutstanding: 0, arrearsIncludingCharges: 197_514, paymentsReceived: 50_000,
})
vi.mock("@/lib/pdf/certificateOfBalance", () => ({
  generateCertificateOfBalancePdf: (...args: unknown[]) => generatePdfMock(...args),
}))
vi.mock("@/lib/config/identity-response", () => ({
  lenderIdentityOrRefusal: (...args: unknown[]) => lenderIdentityMock(...args),
}))

import { GET } from "./route"

const context = { params: Promise.resolve({ id: "loan-1" }) }

// The rate agreed at disbursement, frozen onto the Loan row from the approval
// snapshot, deliberately DIFFERENT from the product's current rate so a live
// read cannot coincidentally produce the right answer.
const AGREED_RATE = 0.03
const AGREED_MODEL = "REDUCING_BALANCE"
const REPRICED_PRODUCT_RATE = 0.05

function loan() {
  return {
    id: "loan-1",
    reference: "LN-TEST-0001",
    startDate: new Date("2026-06-01T00:00:00.000Z"),
    maturityDate: new Date("2026-08-30T00:00:00.000Z"),
    principal: 1_000_000,
    totalRepayable: 1_189_291,
    totalPaid: 0,
    outstandingPrincipal: 1_000_000,
    arrearsAmount: 0,
    daysInArrears: 0,
    lastPaymentDate: null,
    lastPaymentAmount: null,
    interestRatePm: AGREED_RATE,
    interestModel: AGREED_MODEL,
    client: {
      firstName: "Synthetic",
      lastName: "Customer",
      idNumber: "9001015000086",
      addressLine1: "1 Test Street",
      city: "Johannesburg",
    },
    product: { interestRatePm: REPRICED_PRODUCT_RATE },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ error: null, user: { id: "staff-1" } })
  documentAccessCreateMock.mockResolvedValue({ id: "access-1" })
  settlementFiguresMock.mockResolvedValue(figures(false))
  loanFindUniqueMock.mockResolvedValue(loan())
  lenderIdentityMock.mockResolvedValue({ identity: parseLenderIdentity(VALID_LENDER_COLUMNS) })
  generatePdfMock.mockResolvedValue(Buffer.from("%PDF-1.4 certificate"))
})

describe("certificate of balance", () => {
  // F-11: the certificate prints the tenant's own NCR number, and is not
  // issued at all without a configured, valid one.
  it("prints the tenant's configured legal name and NCR number", async () => {
    await GET(new NextRequest("http://localhost/api/loans/loan-1/certificate-of-balance"), context)
    expect(generatePdfMock).toHaveBeenCalledWith(expect.objectContaining({
      lender: expect.objectContaining({ legalName: "Acme Lending (Pty) Ltd", ncrNumber: "NCRCP99999" }),
    }))
  })

  it("refuses with 409 and renders nothing when the lender identity is not configured", async () => {
    lenderIdentityMock.mockResolvedValue({
      refusal: NextResponse.json({ code: "LENDER_IDENTITY_NOT_CONFIGURED" }, { status: 409 }),
    })
    const response = await GET(new NextRequest("http://localhost/api/loans/loan-1/certificate-of-balance"), context)
    expect(response.status).toBe(409)
    expect(generatePdfMock).not.toHaveBeenCalled()
  })

  // NCA s.108: the certificate is a legal statement of the consumer's account,
  // admissible as evidence of the outstanding balance. The interest rate it
  // states must be the rate the consumer actually contracted at — which is
  // frozen onto the Loan row at disbursement. Reading the live LoanProduct row
  // means ordinary repricing retroactively misstates a legal document for every
  // existing loan on that product.
  it("states the rate frozen on the loan, not the product's current rate", async () => {
    const response = await GET(new NextRequest("http://localhost/api/loans/loan-1/certificate-of-balance"), context)

    expect(response.status).toBe(200)
    expect(generatePdfMock).toHaveBeenCalledWith(expect.objectContaining({
      loan: expect.objectContaining({ interestRatePm: AGREED_RATE }),
    }))
  })

  it("states arrears including default charges, cash paid and the amount to settle while charges are live", async () => {
    settlementFiguresMock.mockResolvedValue(figures(true))
    await GET(new NextRequest("http://localhost/api/loans/loan-1/certificate-of-balance"), context)
    expect(generatePdfMock).toHaveBeenCalledWith(expect.objectContaining({
      loan: expect.objectContaining({ arrearsAmount: 197_514 }),
      settlement: expect.objectContaining({ paymentsReceived: 50_000, totalToSettle: 205_514 }),
    }))
  })

  it("renders the certificate as before, with no settlement block, while charges are off", async () => {
    await GET(new NextRequest("http://localhost/api/loans/loan-1/certificate-of-balance"), context)
    expect(generatePdfMock.mock.calls[0][0].settlement).toBeUndefined()
  })

  it("never states the repriced product rate", async () => {
    await GET(new NextRequest("http://localhost/api/loans/loan-1/certificate-of-balance"), context)

    const rendered = generatePdfMock.mock.calls[0][0] as { loan: { interestRatePm: number } }
    expect(rendered.loan.interestRatePm).not.toBe(REPRICED_PRODUCT_RATE)
  })

  // POPIA: access to a consumer's document is logged. CLAUDE.md treats this as
  // a legal obligation, not a nicety.
  it("logs the document access against the accessing staff member", async () => {
    await GET(new NextRequest("http://localhost/api/loans/loan-1/certificate-of-balance"), context)

    expect(documentAccessCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: "loan-1",
        accessorType: "staff",
        accessorId: "staff-1",
        action: "download",
      }),
    })
  })

  it("still serves the certificate when access logging fails", async () => {
    documentAccessCreateMock.mockRejectedValue(new Error("log store down"))

    const response = await GET(new NextRequest("http://localhost/api/loans/loan-1/certificate-of-balance"), context)

    expect(response.status).toBe(200)
  })

  it("returns 404 for a loan outside the tenant", async () => {
    loanFindUniqueMock.mockResolvedValue(null)

    const response = await GET(new NextRequest("http://localhost/api/loans/loan-1/certificate-of-balance"), context)

    expect(response.status).toBe(404)
    expect(generatePdfMock).not.toHaveBeenCalled()
  })
})
