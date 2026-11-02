import { beforeEach, describe, expect, it, vi } from "vitest"
const twoPeople = vi.hoisted(() => ({ refusal: vi.fn(async (): Promise<string | null> => null) }))
vi.mock("@/lib/security/account-control", () => ({ accountControlRefusal: twoPeople.refusal }))

const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    dealSigner: { findFirst: m.findFirst },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ dealSigner: { updateMany: m.updateMany } }),
  },
}))
vi.mock("@/lib/audit", () => ({ AuditAction: { ASSET_DEAL_WET_INK_CONFIRMED: "confirmed" }, logAuditStrict: m.audit }))
vi.mock("./entity-document-io", () => ({ storeEntityDocument: vi.fn() }))

import { confirmWetInkScan } from "./signing-wet-ink"

const signer = {
  id: "signer-1", dealId: "deal-1", clientId: "client-1", document: "AGREEMENT",
  method: "WET_INK", signedAt: null, signatureSha256: null,
  scanDocumentId: "scan-new", scanUploadedById: "uploader", confirmedById: null, confirmedAt: null, issuanceId: "issuance-1",
  deal: { status: "APPROVED", entityId: "entity-1" },
}

describe("wet-ink confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.findFirst.mockResolvedValue(signer)
    m.updateMany.mockResolvedValue({ count: 1 })
  })

  it("refuses when the scan displayed to the reviewer has been replaced", async () => {
    const result = await confirmWetInkScan(
      { tenantId: "tenant-1", userId: "reviewer", userEmail: "reviewer@lender.test" },
      "deal-1",
      "signer-1",
      "scan-old",
    )
    expect(result).toEqual({ kind: "scan_changed" })
    expect(m.updateMany).not.toHaveBeenCalled()
    expect(m.audit).not.toHaveBeenCalled()
  })

  it("reads the two-people rule against whoever uploaded the scan, before anything is written (F12)", async () => {
    twoPeople.refusal.mockResolvedValueOnce("Two people, not two accounts")
    const result = await confirmWetInkScan({ tenantId: "tenant-1", userId: "reviewer", userEmail: "reviewer@lender.test" }, "deal-1", "signer-1", "scan-new")
    expect(result).toEqual({ kind: "account_controlled", error: "Two people, not two accounts" })
    expect(twoPeople.refusal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ makerIds: ["uploader"], checkerId: "reviewer" }))
    expect(m.updateMany).not.toHaveBeenCalled()
  })

  it("pins the update predicate to the reviewed scan", async () => {
    await confirmWetInkScan(
      { tenantId: "tenant-1", userId: "reviewer", userEmail: "reviewer@lender.test" },
      "deal-1",
      "signer-1",
      "scan-new",
    )
    expect(m.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ scanDocumentId: "scan-new" }),
    }))
  })
})
