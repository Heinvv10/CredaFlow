// The NCA quotation carries the tenant's legal-wording flag into the renderer
// (its audit row records no wording state).
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ approved: vi.fn(), render: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/audit", () => ({ AuditAction: new Proxy({}, { get: (_t, key) => String(key) }), logAuditStrict: vi.fn() }))
vi.mock("@/lib/config/identity", () => ({ getLenderIdentity: vi.fn(async () => ({ legalName: "TEST Lender", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road"] })) }))
vi.mock("@/lib/storage", () => ({ saveFile: vi.fn(async () => ({ storagePath: "store/quote.pdf", fileSize: 10 })), deleteFile: vi.fn(), readFile: vi.fn() }))
vi.mock("@/lib/insurance/credit-life-election.server", () => ({ verifyAppliedCreditLifeDisclosure: () => ({ ok: true, evidence: {} }) }))
vi.mock("./deal-structure", () => ({ resolveRate: vi.fn(async () => ({ annualRate: "0.1175", reference: null })) }))
vi.mock("./deal-terms", () => ({
  DEAL_STRUCTURE_SELECT: {},
  termsFromDeal: () => ({ depositCents: 0, balloonCents: 0, financedFeesCents: 0, rate: { basis: "FIXED", margin: null, fixedRate: "0.1175" } }),
}))
vi.mock("./nca-structure", () => ({ solveNcaDealStructure: () => ({ ok: true, result: { rows: [{ principalCents: 100, feesCents: 5 }] } }) }))
vi.mock("./nca-evidence", () => ({
  pasqJson: (e: unknown) => e,
  createAssetPasqEvidence: () => ({
    version: 1, evidenceSha256: "e",
    calculator: { principalCents: 100, initiationFeeCents: 0, totalInterestCents: 10 },
    creditLife: { monthlyPremiumCents: 0 }, totalCostOfCreditCents: 15,
    billing: { recurringPaymentCents: 115, totalRepayableCents: 115, schedule: [
      { installmentNo: 1, dueDate: "2026-11-29T22:00:00.000Z", principalDueCents: 100, interestDueCents: 10, feesDueCents: 5, totalDueCents: 115, closingBalanceCents: 0 },
    ] },
  }),
}))
vi.mock("./documents/nca/quote-pdf", () => ({ renderNcaAssetQuote: m.render }))
vi.mock("./documents/nca/legal-wording-approved", () => ({ legalWordingApproved: m.approved }))

import { issueAssetNcaQuote } from "./nca-quote-store"
import type { RegimeTx } from "./classification"

const deal = {
  id: "d1", status: "APPROVED", contractType: "INSTALMENT_SALE", clientId: "c1", entityId: null,
  application: { id: "a1", reference: "AF-TEST", status: "APPROVED", productId: "p1", appliedTermDays: 365, pasqDocumentId: null, ncaRepresentativeClientId: null },
  client: { id: "c1", firstName: "TEST", lastName: "Borrower", idNumber: "0000000000000", addressLine1: null, city: null, province: null, postalCode: null },
  entity: null,
  asset: { make: "TEST", model: "TLB", year: 2026, serialNumber: "SN-TEST", vin: null, cashPriceExclVatCents: 100, vatCents: 15 },
}

describe("issueAssetNcaQuote passes the tenant's legal-wording flag through", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.render.mockResolvedValue(Buffer.from("pdf"))
  })

  const txWith = (agreementBasis: "SYNTHETIC_DEMO" | "LENDER_LEGAL" | null) => ({
    assetFinanceDeal: { findFirst: vi.fn(async () => deal) }, clientDocument: { create: vi.fn() }, entityDocument: { create: vi.fn() },
    loanApplication: { update: vi.fn() },
    documentTemplate: { findFirst: vi.fn(async () => (agreementBasis ? { versions: [{ approvalBasis: agreementBasis }] } : null)) },
  } as unknown as RegimeTx)

  it.each([true, false])("approved=%s reaches the renderer", async (approved) => {
    m.approved.mockResolvedValue(approved)
    const tx = txWith(null)
    expect((await issueAssetNcaQuote(tx, { tenantId: "t1", userId: "u1" }, "d1")).kind).toBe("issued")
    expect(m.approved).toHaveBeenCalledWith(tx, "t1")
    expect(m.render).toHaveBeenCalledWith(expect.objectContaining({ legalWordingApproved: approved, schedule: [expect.objectContaining({ dueDate: "2026-11-30", principalCents: 100, feesCents: 5 })] }))
  })

  it("refuses a DRAFT quotation the lender's legally approved agreement could never follow; a demo agreement is no bar", async () => {
    m.approved.mockResolvedValue(false)
    const refused = await issueAssetNcaQuote(txWith("LENDER_LEGAL"), { tenantId: "t1", userId: "u1" }, "d1")
    expect(refused).toMatchObject({ kind: "not_ready", reason: expect.stringMatching(/quotation wording is not yet/) })
    expect(m.render).not.toHaveBeenCalled()
    expect((await issueAssetNcaQuote(txWith("SYNTHETIC_DEMO"), { tenantId: "t1", userId: "u1" }, "d1")).kind).toBe("issued")
  })
})
