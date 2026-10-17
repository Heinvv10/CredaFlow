// The NCA agreement carries the tenant's legal-wording flag into the renderer and
// records its inverse as draftLegalWording on the compliance record and the audit row.
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  findFirst: vi.fn(), transaction: vi.fn(), audit: vi.fn(), approved: vi.fn(), render: vi.fn(), compliance: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { assetFinanceDeal: { findFirst: m.findFirst }, $transaction: m.transaction } }))
vi.mock("@/lib/audit", () => ({ AuditAction: new Proxy({}, { get: (_t, key) => String(key) }), logAuditStrict: m.audit }))
vi.mock("@/lib/config/identity", () => ({ getLenderIdentity: vi.fn(async () => ({ legalName: "TEST Lender", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road"] })) }))
vi.mock("@/lib/storage", () => ({ saveFile: vi.fn(async () => ({ storagePath: "store/agreement.pdf", fileSize: 10 })), deleteFile: vi.fn(), readFile: vi.fn() }))
vi.mock("@/lib/compliance/pasq", () => ({ pasqEvidenceIsIntact: () => true }))
vi.mock("@/lib/compliance/provider-countersign", () => ({ providerCountersignatureEnvelopeSha256: vi.fn(), providerCountersignatureSha256: vi.fn() }))
vi.mock("@/lib/signing-otp/challenge", () => ({ checkSigningOtp: vi.fn(), consumeSigningOtp: vi.fn(), SigningOtpRefusedError: class extends Error {} }))
vi.mock("@/lib/signing-otp/policy", () => ({ isSigningOtpRequired: vi.fn() }))
vi.mock("./payout-checklist-store", () => ({ createPayoutChecklist: vi.fn() }))
vi.mock("./deal-structure", () => ({ resolveRate: vi.fn(async () => ({ annualRate: "0.1175", reference: null })) }))
vi.mock("./documents/nca/agreement-pdf", () => ({ renderNcaAssetAgreement: m.render }))
vi.mock("./documents/nca/legal-wording-approved", () => ({ legalWordingApproved: m.approved }))

import { issueAssetNcaAgreement } from "./nca-agreement-store"

const row = { installmentNo: 1, dueDate: "2026-11-30T00:00:00.000Z", principalDueCents: 100, interestDueCents: 10, feesDueCents: 5, totalDueCents: 115, closingBalanceCents: 0 }
const evidence = {
  calculator: { startDate: "2026-10-31T00:00:00.000Z", principalCents: 100, initiationFeeCents: 0, serviceFeesCents: 5, schedule: [row], totalInterestCents: 10, recurringInstalmentCents: 115 },
  creditLife: { monthlyPremiumCents: 0, election: "DECLINED" },
  billing: { recurringPaymentCents: 115, totalRepayableCents: 115, schedule: [row] },
  totalCostOfCreditCents: 15,
}
const deal = {
  id: "d1", tenantId: "t1", clientId: "c1", status: "APPROVED", contractType: "INSTALMENT_SALE", decidedAt: new Date("2026-10-13T08:00:00Z"),
  depositCents: 0, balloonCents: 0, rateBasis: "FIXED", rateMargin: null, fixedRate: "0.1175",
  application: { id: "a1", reference: "AF-TEST", status: "APPROVED", pasqEvidence: evidence, pasqDocumentSha256: "q", pasqAcknowledgedSha256: "q", agreementDocumentId: null },
  client: { id: "c1", firstName: "TEST", lastName: "Borrower", idNumber: "0000000000000", addressLine1: null, city: null, province: null, postalCode: null },
  asset: { make: "TEST", model: "TLB", year: 2026, serialNumber: "SN-TEST", vin: null, cashPriceExclVatCents: 100, vatCents: 15 },
}

describe("issueAssetNcaAgreement passes the tenant's legal-wording flag through", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.findFirst.mockResolvedValue(deal)
    m.render.mockResolvedValue(Buffer.from("pdf"))
    m.transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run({
      clientDocument: { create: vi.fn() }, complianceRecord: { create: m.compliance }, loanApplication: { updateMany: vi.fn(async () => ({ count: 1 })) },
      dealSigner: { create: vi.fn() }, assetFinanceDeal: { update: vi.fn() },
    }))
  })

  it.each([true, false])("approved=%s reaches the renderer, the compliance record and the audit row", async (approved) => {
    m.approved.mockResolvedValue(approved)
    expect((await issueAssetNcaAgreement({ tenantId: "t1", userId: "u1" }, "d1")).kind).toBe("done")
    expect(m.approved).toHaveBeenCalledWith(expect.anything(), "t1")
    expect(m.render).toHaveBeenCalledWith(expect.objectContaining({ legalWordingApproved: approved }))
    expect(m.compliance).toHaveBeenCalledWith({ data: expect.objectContaining({ data: expect.objectContaining({ draftLegalWording: !approved }) }) })
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ newValue: expect.objectContaining({ draftLegalWording: !approved }) }), expect.anything())
  })
})
