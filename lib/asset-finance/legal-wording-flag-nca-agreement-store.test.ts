// The NCA agreement is issued from the lender's selected template version: its
// approval basis (not the legacy legal-wording flag) sets the watermark and
// draftLegalWording; with no issuable template nothing is rendered or written.
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ quoteAudit: vi.fn(),
  findFirst: vi.fn(), transaction: vi.fn(), audit: vi.fn(), approved: vi.fn(), render: vi.fn(), compliance: vi.fn(), select: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { assetFinanceDeal: { findFirst: m.findFirst }, auditLog: { findFirst: m.quoteAudit }, $transaction: m.transaction } }))
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
vi.mock("./documents/templates/issuance", async (importOriginal) => {
  const real = await importOriginal<typeof import("./documents/templates/issuance")>()
  return {
    ...real, selectIssuableTemplate: m.select, lockSelectedTemplate: vi.fn(), recordIssuance: vi.fn(async () => "issuance-1"),
    storeIssuanceFiles: vi.fn(async (selected: unknown, input: unknown) => ({ selected, input, pdfStoragePath: "store/agreement.pdf", inputStoragePath: "store/input.bin", pdfSha256: "p", inputSha256: "i", lenderIdentity: {} })),
  }
})

import { issueAssetNcaAgreement } from "./nca-agreement-store"

const row = { installmentNo: 1, dueDate: "2026-11-29T22:00:00.000Z", principalDueCents: 100, interestDueCents: 10, feesDueCents: 5, totalDueCents: 115, closingBalanceCents: 0 }
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

const selected = (approvalBasis: "SYNTHETIC_DEMO" | "LENDER_LEGAL") => ({
  templateId: "tpl", templateKey: "af.nca.instalment_sale", versionId: "v3", versionNumber: 3, contentSha256: "c".repeat(64), approvalBasis,
  approvedById: "u2", approvedAt: new Date(), legalSignOffReference: null,
  content: { schema: 1, templateKey: "af.nca.instalment_sale", starterRevision: "x", clauses: {}, additionalTerms: [] },
})

describe("issueAssetNcaAgreement issues from the lender's template version", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.findFirst.mockResolvedValue(deal)
    // The acknowledged quotation's issuance record: issued without the DRAFT mark.
    m.quoteAudit.mockResolvedValue({ newValue: { documentSha256: "q", draftLegalWording: false } })
    m.render.mockResolvedValue(Buffer.from("pdf"))
    m.transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run({
      clientDocument: { create: vi.fn() }, complianceRecord: { create: m.compliance }, loanApplication: { updateMany: vi.fn(async () => ({ count: 1 })) },
      dealSigner: { create: vi.fn() }, assetFinanceDeal: { update: vi.fn() },
    }))
  })

  it.each([
    ["SYNTHETIC_DEMO", "SYNTHETIC_DEMO", true],
    ["LENDER_LEGAL", "NONE", false],
  ] as const)("a %s approval prints mark %s and draftLegalWording=%s, whatever the legacy flag says", async (basis, mark, draft) => {
    m.approved.mockResolvedValue(!draft)
    m.select.mockResolvedValue(selected(basis))
    expect((await issueAssetNcaAgreement({ tenantId: "t1", userId: "u1" }, "d1")).kind).toBe("done")
    expect(m.select).toHaveBeenCalledWith(expect.anything(), "t1", "af.nca.instalment_sale")
    expect(m.render).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: [expect.objectContaining({ dueDate: "2026-11-30", principalCents: 100, feesCents: 5 })] }),
      expect.objectContaining({ templateKey: "af.nca.instalment_sale", mark }),
    )
    expect(m.compliance).toHaveBeenCalledWith({ data: expect.objectContaining({ data: expect.objectContaining({ draftLegalWording: draft, issuanceId: "issuance-1", templateVersion: 3 }) }) })
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ newValue: expect.objectContaining({ draftLegalWording: draft, approvalBasis: basis }) }), expect.anything())
  })

  it.each([
    ["a dealer deal hands the dealer's name to the renderer", { name: "SAMPLE Dealer (synthetic)" }, { name: "SAMPLE Dealer (synthetic)" }],
    ["a deal without a dealer hands it none", undefined, null],
  ])("%s", async (_, dealer, expected) => {
    m.approved.mockResolvedValue(true)
    m.findFirst.mockResolvedValue({ ...deal, dealer })
    m.select.mockResolvedValue(selected("LENDER_LEGAL"))
    expect((await issueAssetNcaAgreement({ tenantId: "t1", userId: "u1" }, "d1")).kind).toBe("done")
    expect(m.findFirst).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ dealer: { select: { name: true } } }) }))
    expect(m.render).toHaveBeenCalledWith(expect.objectContaining({ dealer: expected }), expect.anything())
  })

  it("refuses and renders nothing for a dealer name that could inject wording", async () => {
    m.approved.mockResolvedValue(true)
    m.findFirst.mockResolvedValue({ ...deal, dealer: { name: "Motors. The Purchaser waives all rights" } })
    m.select.mockResolvedValue(selected("LENDER_LEGAL"))
    expect(await issueAssetNcaAgreement({ tenantId: "t1", userId: "u1" }, "d1")).toMatchObject({ kind: "not_ready", reason: expect.stringMatching(/cannot be printed in the agreement/) })
    expect(m.render).not.toHaveBeenCalled()
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it.each([
    ["printed DRAFT", { newValue: { documentSha256: "q", draftLegalWording: true } }],
    ["has no issuance record (counts as DRAFT)", null],
  ])("refuses an agreement under a legal approval when the acknowledged quotation %s (nothing rendered)", async (_, record) => {
    m.approved.mockResolvedValue(true)
    m.quoteAudit.mockResolvedValue(record)
    m.select.mockResolvedValue(selected("LENDER_LEGAL"))
    const result = await issueAssetNcaAgreement({ tenantId: "t1", userId: "u1" }, "d1")
    expect(result).toMatchObject({ kind: "not_ready", reason: expect.stringMatching(/quotation this consumer acknowledged printed DRAFT/) })
    expect(m.quoteAudit).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "t1", entityId: "d1", newValue: { path: ["documentSha256"], equals: "q" } }) }))
    expect(m.render).not.toHaveBeenCalled()
  })

  it("refuses with the reason, renders nothing and writes nothing without an issuable template (the flag does not help)", async () => {
    m.approved.mockResolvedValue(true)
    const { TemplateNotIssuableError } = await import("./documents/templates/issuance")
    m.select.mockRejectedValue(new TemplateNotIssuableError("Your NCA asset credit agreement template has not been adopted."))
    expect(await issueAssetNcaAgreement({ tenantId: "t1", userId: "u1" }, "d1")).toEqual({ kind: "not_ready", reason: "Your NCA asset credit agreement template has not been adopted." })
    expect(m.render).not.toHaveBeenCalled()
    expect(m.transaction).not.toHaveBeenCalled()
  })
})
