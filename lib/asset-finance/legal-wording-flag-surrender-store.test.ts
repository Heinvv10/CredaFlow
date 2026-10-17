// The s127 notice carries the tenant's legal-wording flag into the renderer and
// records its inverse as draftLegalWording on the audit row (never hard-coded).
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  findFirst: vi.fn(), transaction: vi.fn(), audit: vi.fn(), approved: vi.fn(), renderValuation: vi.fn(), renderFinal: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { surrenderRequest: { findFirst: m.findFirst }, $transaction: m.transaction } }))
vi.mock("@/lib/audit", () => ({ AuditAction: new Proxy({}, { get: (_t, key) => String(key) }), logAuditStrict: m.audit }))
vi.mock("@/lib/config/identity", () => ({ getLenderIdentity: vi.fn(async () => ({ legalName: "TEST Lender", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road"] })) }))
vi.mock("@/lib/storage", () => ({ saveFile: vi.fn(async () => ({ storagePath: "store/notice.pdf", fileSize: 10 })), deleteFile: vi.fn() }))
vi.mock("@/lib/loan/apply-payment", () => ({ applyManualReceipt: vi.fn() }))
vi.mock("@/lib/loan/charges-summary", () => ({ loanSettlementFigures: vi.fn() }))
vi.mock("./documents/nca/surrender-pdf", () => ({ renderSurrenderValuationNotice: m.renderValuation, renderSurrenderFinalNotice: m.renderFinal }))
vi.mock("./documents/nca/legal-wording-approved", () => ({ legalWordingApproved: m.approved }))

import { issueSurrenderNotice } from "./surrender-store"

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const row = {
  id: "s1", status: "VALUED", requestedOn: day("2026-10-13"), valuationDueOn: day("2026-10-27"), assetCondition: "Synthetic",
  saleProceedsCents: null, shortfallCents: null, refundCents: null,
  valuation: { valuedOn: day("2026-10-20"), valuerName: "TEST Valuer", amountCents: 125_000 },
  loan: { reference: "AF-TEST", client: { firstName: "TEST", lastName: "Borrower", idNumber: "0000000000000", addressLine1: null, city: null, province: null, postalCode: null }, entity: null },
  asset: { year: 2026, make: "TEST", model: "TLB", vin: null, serialNumber: "SN-TEST" },
  recovery: null,
}

describe("issueSurrenderNotice passes the tenant's legal-wording flag through", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.findFirst.mockResolvedValue(row)
    m.renderValuation.mockResolvedValue(Buffer.from("pdf"))
    m.transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run({ surrenderRequest: { update: vi.fn() } }))
  })

  it.each([true, false])("approved=%s reaches the renderer and the audit row as draftLegalWording=!approved", async (approved) => {
    m.approved.mockResolvedValue(approved)
    expect(await issueSurrenderNotice({ tenantId: "t1", userId: "u1" }, "s1", "valuation")).toEqual({ kind: "done", id: "s1" })
    expect(m.approved).toHaveBeenCalledWith(expect.anything(), "t1")
    expect(m.renderValuation).toHaveBeenCalledWith(expect.objectContaining({ legalWordingApproved: approved }))
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ newValue: expect.objectContaining({ draftLegalWording: !approved }) }), expect.anything())
  })
})
