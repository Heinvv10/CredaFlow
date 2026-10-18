// An entity NCA deal's agreement is issued from the lender's af.nca template
// version: the version's basis sets the mark, recorded on the audit row; the
// loader's legacy legal-wording flag changes nothing.
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ findFirst: vi.fn(), transaction: vi.fn(), audit: vi.fn(), load: vi.fn(), render: vi.fn(), select: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { assetFinanceDeal: { findFirst: m.findFirst }, $transaction: m.transaction } }))
vi.mock("@/lib/audit", () => ({ AuditAction: new Proxy({}, { get: (_t, key) => String(key) }), logAuditStrict: m.audit }))
vi.mock("@/lib/config/identity", () => ({ getLenderIdentity: vi.fn(async () => ({ legalName: "TEST Lender", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road"] })) }))
vi.mock("@/lib/storage", () => ({ saveFile: vi.fn(async () => ({ storagePath: "store/agreement.pdf", fileSize: 10 })), deleteFile: vi.fn() }))
vi.mock("@/lib/compliance/pasq", () => ({ pasqEvidenceIsIntact: () => true }))
vi.mock("./documents/nca/agreement-pdf", () => ({ renderNcaAssetAgreement: m.render }))
vi.mock("./documents/deal-document-data", () => ({ loadDealDocumentData: m.load, DealDocumentError: class extends Error {} }))
vi.mock("./documents/render", () => ({ renderDealDocument: vi.fn() }))
vi.mock("./deal-structure", () => ({ resolveRate: vi.fn(async () => ({ annualRate: "0.1175", reference: null })) }))
vi.mock("./deal-terms", () => ({ DEAL_STRUCTURE_SELECT: {}, termsFromDeal: () => ({ rate: { basis: "FIXED", margin: null, fixedRate: "0.1175" } }) }))
vi.mock("./signing", () => ({ preparedSignerSet: () => [] }))
vi.mock("./documents/templates/issuance", async (importOriginal) => {
  const real = await importOriginal<typeof import("./documents/templates/issuance")>()
  return {
    ...real, selectIssuableTemplate: m.select, lockSelectedTemplate: vi.fn(), recordIssuance: vi.fn(async () => "issuance-1"),
    supersedeIssuances: vi.fn(async () => []),
    storeIssuanceFiles: vi.fn(async (selected: unknown, input: unknown) => ({ selected, input, pdfStoragePath: "store/agreement.pdf", inputStoragePath: "store/input.bin", pdfSha256: "p", inputSha256: "i", lenderIdentity: {} })),
  }
})
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

describe("prepareEntityNcaDocuments issues the agreement from the lender's template version", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.findFirst.mockResolvedValue(deal)
    m.render.mockResolvedValue(Buffer.from("pdf"))
    m.transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run({
      dealSigner: { findMany: vi.fn(async () => []), deleteMany: vi.fn(), create: vi.fn(async () => ({ id: "signer-1" })) },
      assetFinanceDeal: { update: vi.fn() }, loanApplication: { update: vi.fn() },
    }))
  })

  it.each([
    [true, "SYNTHETIC_DEMO", "SYNTHETIC_DEMO"],
    [false, "LENDER_LEGAL", "NONE"],
  ] as const)("legacy flag %s, a %s approval: the agreement prints mark %s", async (flag, basis, mark) => {
    m.load.mockResolvedValue({ legalWordingApproved: flag, ncaApplies: true, pricing: {}, requiredSigners: REQUIRED })
    m.select.mockResolvedValue({
      templateId: "tpl", templateKey: "af.nca.instalment_sale", versionId: "v2", versionNumber: 2, contentSha256: "c".repeat(64), approvalBasis: basis,
      approvedById: "u2", approvedAt: new Date(), legalSignOffReference: null,
      content: { schema: 1, templateKey: "af.nca.instalment_sale", starterRevision: "x", clauses: {}, additionalTerms: [] },
    })
    expect(await prepareEntityNcaDocuments({ tenantId: "t1", userId: "u1" }, "d1")).toEqual({ kind: "prepared", signers: 1 })
    expect(m.select).toHaveBeenCalledWith(expect.anything(), "t1", "af.nca.instalment_sale")
    expect(m.render).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mark }))
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ newValue: expect.objectContaining({
      templates: [expect.objectContaining({ templateKey: "af.nca.instalment_sale", templateVersion: 2, approvalBasis: basis, issuanceId: "issuance-1" })],
    }) }), expect.anything())
  })
})
