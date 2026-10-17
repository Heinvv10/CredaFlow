// An entity NCA deal's agreement takes the tenant's legal-wording flag from the
// deal-document loader, and the audit row records its inverse as draftLegalWording.
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ findFirst: vi.fn(), transaction: vi.fn(), audit: vi.fn(), load: vi.fn(), render: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { assetFinanceDeal: { findFirst: m.findFirst }, $transaction: m.transaction } }))
vi.mock("@/lib/audit", () => ({ AuditAction: new Proxy({}, { get: (_t, key) => String(key) }), logAuditStrict: m.audit }))
vi.mock("@/lib/config/identity", () => ({ getLenderIdentity: vi.fn(async () => ({ legalName: "TEST Lender", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road"] })) }))
vi.mock("@/lib/storage", () => ({ saveFile: vi.fn(async () => ({ storagePath: "store/agreement.pdf", fileSize: 10 })), deleteFile: vi.fn() }))
vi.mock("@/lib/compliance/pasq", () => ({ pasqEvidenceIsIntact: () => true }))
vi.mock("./documents/nca/agreement-pdf", () => ({ renderNcaAssetAgreement: m.render }))
vi.mock("./documents/deal-document-data", () => ({ loadDealDocumentData: m.load }))
vi.mock("./documents/render", () => ({ renderDealDocument: vi.fn() }))
vi.mock("./deal-structure", () => ({ resolveRate: vi.fn(async () => ({ annualRate: "0.1175", reference: null })) }))
vi.mock("./deal-terms", () => ({ DEAL_STRUCTURE_SELECT: {}, termsFromDeal: () => ({ rate: { basis: "FIXED", margin: null, fixedRate: "0.1175" } }) }))
vi.mock("./signing", () => ({ preparedSignerSet: () => [] }))
const REQUIRED = [{ clientId: "rep", role: "AUTHORISED_SIGNATORY", document: "AGREEMENT" }]
vi.mock("./signing-prepare", () => ({ currentRequiredSigners: vi.fn(async () => REQUIRED), lockDeal: vi.fn(async () => ({ status: "APPROVED" })) }))

import { prepareEntityNcaDocuments } from "./nca-entity-signing"

const row = { installmentNo: 1, dueDate: "2026-11-30T00:00:00.000Z", openingBalanceCents: 100, principalDueCents: 100, interestDueCents: 10, feesDueCents: 5, totalDueCents: 115, closingBalanceCents: 0 }
const evidence = {
  calculator: { startDate: "2026-10-31T00:00:00.000Z", principalCents: 100, initiationFeeCents: 0, serviceFeesCents: 5, schedule: [row], totalInterestCents: 10, recurringInstalmentCents: 115 },
  creditLife: { monthlyPremiumCents: 0 }, billing: { recurringPaymentCents: 115, totalRepayableCents: 115, schedule: [row] }, totalCostOfCreditCents: 15,
}
const deal = {
  id: "d1", status: "APPROVED", entityId: "e1", contractType: "INSTALMENT_SALE", decidedAt: new Date("2026-10-13T08:00:00Z"),
  depositCents: 0, balloonCents: 0, rateBasis: "FIXED", rateMargin: null,
  application: { id: "a1", reference: "AF-TEST", status: "APPROVED", ncaRegime: "NCA", ncaRepresentativeClientId: "rep", pasqEvidence: evidence, pasqDocumentSha256: "q", pasqAcknowledgedSha256: "q" },
  entity: { legalName: "TEST Entity", registrationNumber: "2099/000001/07", mastersReference: null, addressLine1: null, addressLine2: null, city: null, province: null, postalCode: null },
  asset: { make: "TEST", model: "TLB", year: 2026, serialNumber: "SN-TEST", vin: null, cashPriceExclVatCents: 100, vatCents: 15 },
}

describe("prepareEntityNcaDocuments passes the tenant's legal-wording flag through", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.findFirst.mockResolvedValue(deal)
    m.render.mockResolvedValue(Buffer.from("pdf"))
    m.transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run({
      dealSigner: { findMany: vi.fn(async () => []), deleteMany: vi.fn(), create: vi.fn(async () => ({ id: "signer-1" })) },
      assetFinanceDeal: { update: vi.fn() }, loanApplication: { update: vi.fn() },
    }))
  })

  it.each([true, false])("approved=%s from the loader reaches the agreement renderer and the audit row", async (approved) => {
    m.load.mockResolvedValue({ legalWordingApproved: approved, ncaApplies: true, pricing: {}, requiredSigners: REQUIRED })
    expect(await prepareEntityNcaDocuments({ tenantId: "t1", userId: "u1" }, "d1")).toEqual({ kind: "prepared", signers: 1 })
    expect(m.render).toHaveBeenCalledWith(expect.objectContaining({ legalWordingApproved: approved }))
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ newValue: expect.objectContaining({ draftLegalWording: !approved }) }), expect.anything())
  })
})
