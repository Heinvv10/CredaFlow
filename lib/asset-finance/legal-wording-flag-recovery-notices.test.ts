// The s131 notice data carries the tenant's legal-wording flag (loadRecoveryNoticeData),
// and the issued notice records its inverse as draftLegalWording on the audit row.
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  findFirst: vi.fn(), transaction: vi.fn(), audit: vi.fn(), approved: vi.fn(), renderValuation: vi.fn(), updateMany: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { recovery: { findFirst: m.findFirst }, $transaction: m.transaction } }))
vi.mock("@/lib/audit", () => ({ AuditAction: new Proxy({}, { get: (_t, key) => String(key) }), logAuditStrict: m.audit }))
vi.mock("@/lib/config/identity", () => ({ getLenderIdentity: vi.fn(async () => ({ legalName: "TEST Lender", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road"] })) }))
vi.mock("@/lib/storage", () => ({ saveFile: vi.fn(async () => ({ storagePath: "store/notice.pdf", fileSize: 10 })), deleteFile: vi.fn() }))
vi.mock("./documents/nca/recovery-pdf", () => ({ renderRecoveryValuationNotice: m.renderValuation, renderRecoveryFinalNotice: vi.fn() }))
vi.mock("./documents/post-sale-statement", () => ({ renderPostSaleStatement: vi.fn() }))
vi.mock("./documents/nca/legal-wording-approved", () => ({ legalWordingApproved: m.approved }))
vi.mock("./surrender-store", () => ({ issueSurrenderNotice: vi.fn(), readSurrenderNotice: vi.fn() }))

import { loadRecoveryNoticeData } from "./recovery-notice-data"
import { issueRecoveryValuationNotice } from "./recovery-notices"

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const row = {
  id: "r1", route: "NCA_S131", status: "VALUED", surrenderRequestId: null, recoveredOn: day("2026-10-10"), location: "TEST Yard", condition: "Synthetic",
  settlementDueCents: null, grossProceedsCents: null, deductedCostsCents: null, chargedCostsCents: null, netProceedsCents: null,
  shortfallCents: null, surplusCents: null, unrecoverableCostsCents: null,
  valuation: { valuedOn: day("2026-10-12"), valuerName: "TEST Valuer", amountCents: 125_000 },
  asset: { year: 2026, make: "TEST", model: "TLB", vin: null, serialNumber: "SN-TEST" },
  loan: { reference: "AF-TEST", client: { firstName: "TEST", lastName: "Borrower", idNumber: "0000000000000", addressLine1: null, city: null, province: null, postalCode: null }, entity: null },
  costs: [],
}

describe("the s131 recovery notice passes the tenant's legal-wording flag through", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.findFirst.mockResolvedValue(row)
    m.renderValuation.mockResolvedValue(Buffer.from("pdf"))
    m.updateMany.mockResolvedValue({ count: 1 })
    m.transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run({ recovery: { updateMany: m.updateMany } }))
  })

  it.each([true, false])("loadRecoveryNoticeData: approved=%s is the notice data's flag", async (approved) => {
    m.approved.mockResolvedValue(approved)
    const loaded = await loadRecoveryNoticeData("t1", "r1", new Date("2026-10-13T08:00:00Z"))
    expect(m.approved).toHaveBeenCalledWith(expect.anything(), "t1")
    expect(loaded?.data.legalWordingApproved).toBe(approved)
  })

  it.each([true, false])("issueRecoveryValuationNotice: approved=%s reaches the renderer and the audit row as draftLegalWording=!approved", async (approved) => {
    m.approved.mockResolvedValue(approved)
    expect(await issueRecoveryValuationNotice({ tenantId: "t1", userId: "u1" }, "r1")).toEqual({ kind: "done", id: "r1" })
    expect(m.renderValuation).toHaveBeenCalledWith(expect.objectContaining({ legalWordingApproved: approved }))
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ newValue: expect.objectContaining({ draftLegalWording: !approved }) }), expect.anything())
  })
})
