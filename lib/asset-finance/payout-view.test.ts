import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  deal: vi.fn(),
  config: vi.fn(),
  currentAccount: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    assetFinanceDeal: { findFirst: m.deal },
    tenantConfig: { findUnique: m.config },
    supplierBankAccount: { findFirst: m.currentAccount },
  },
}))

import { loadPayoutPanel } from "./payout-view"

const account = (tail: string) => ({ bankName: "Test Bank", accountNumber: `000000${tail}`, accountHolder: "Synthetic Supplier" })
const deal = (payout: null | { supplierBankAccount: ReturnType<typeof account> }) => ({
  status: "CONTRACTED",
  entityId: "entity-1",
  contractType: "INSTALMENT_SALE",
  supplierId: "supplier-1",
  depositCents: 0,
  tradeInCents: 0,
  asset: { cashPriceExclVatCents: 100, vatCents: 15, registrationNumber: null },
  checklist: [],
  documents: [],
  payout: payout && {
    ...payout,
    status: "APPROVED",
    amountCents: 115,
    dualApprovalRequired: false,
    createdById: "user-1",
    releasedAt: null,
    createdBy: { name: "Test User", email: "user@test.invalid" },
    approvedBy: null,
  },
  loan: null,
})

describe("loadPayoutPanel bank account", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.config.mockResolvedValue({ assetPayoutDualApprovalCents: null })
    m.currentAccount.mockResolvedValue(account("2222"))
  })

  it("shows the immutable account bound to an existing payout", async () => {
    m.deal.mockResolvedValue(deal({ supplierBankAccount: account("1111") }))

    const panel = await loadPayoutPanel("tenant-1", "deal-1")

    expect(panel?.approvedAccount?.accountNumberTail).toBe("1111")
    expect(m.currentAccount).not.toHaveBeenCalled()
  })

  it("shows the current approved account before a payout exists", async () => {
    m.deal.mockResolvedValue(deal(null))

    const panel = await loadPayoutPanel("tenant-1", "deal-1")

    expect(panel?.approvedAccount?.accountNumberTail).toBe("2222")
    expect(m.currentAccount).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", supplierId: "supplier-1", status: "APPROVED" },
    }))
  })
})

describe("loadPayoutPanel segregation of duties", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.currentAccount.mockResolvedValue(account("2222"))
    m.deal.mockResolvedValue(deal(null))
  })

  it.each([
    [{ assetPayoutDualApprovalCents: 100, requireSegregationOfDuties: true }, true],
    [{ assetPayoutDualApprovalCents: 100, requireSegregationOfDuties: false }, false],
    [null, true],
  ])("reports the lender's setting (%j -> %s)", async (config, expected) => {
    m.config.mockResolvedValue(config)
    expect((await loadPayoutPanel("tenant-1", "deal-1"))?.segregationOfDuties).toBe(expected)
  })
})
