import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * createPayout's half of segregation of duties: while the lender's setting is
 * on, a payout below the dual-approval threshold is still created
 * PENDING_APPROVAL (guardPayout refuses anything else; payout-booking
 * integration test). Off, below the threshold the creation is the approval.
 */
const h = vi.hoisted(() => ({ config: vi.fn(), create: vi.fn(), audit: vi.fn() }))

vi.mock("./signing-prepare", () => ({ lockDeal: async () => ({ status: "CONTRACTED", entityId: "entity-1", clientId: null }) }))
vi.mock("@/lib/audit", () => ({ AuditAction: new Proxy({}, { get: (_t, k) => String(k) }), logAuditStrict: (...args: unknown[]) => h.audit(...args) }))
vi.mock("@/lib/prisma", () => {
  const tx = {
    assetFinanceDeal: {
      findFirstOrThrow: async () => ({
        contractType: "INSTALMENT_SALE", supplierId: "supplier-1", depositCents: 0, tradeInCents: 0,
        asset: { cashPriceExclVatCents: 1_000_000, vatCents: 150_000, registrationNumber: null },
        checklist: [], payout: null,
      }),
    },
    supplierBankAccount: { findFirst: async () => ({ id: "account-1" }) },
    tenantConfig: { findUnique: (...args: unknown[]) => h.config(...args) },
    payout: { create: (...args: unknown[]) => h.create(...args) },
  }
  return { prisma: { $transaction: async (cb: (t: typeof tx) => unknown) => cb(tx) } }
})
vi.mock("./payout-checklist", async (importOriginal) => ({
  ...await importOriginal<typeof import("./payout-checklist")>(),
  requiredChecklistKinds: () => [],
}))

import { createPayout } from "./payout"

const actor = { tenantId: "tenant-1", userId: "creator-1", userEmail: "creator@example.invalid" }

beforeEach(() => {
  vi.clearAllMocks()
  h.create.mockImplementation(async ({ data }: { data: { status: string } }) => ({ id: "payout-1", status: data.status, dualApprovalRequired: data.status === "PENDING_APPROVAL" }))
})

describe("createPayout below the dual-approval threshold", () => {
  it("needs a second approver while segregation of duties is on", async () => {
    h.config.mockResolvedValue({ assetPayoutDualApprovalCents: 100_000_000, requireSegregationOfDuties: true })
    expect(await createPayout(actor, "deal-1")).toEqual({ kind: "created", payoutId: "payout-1", status: "PENDING_APPROVAL" })
    expect(h.create.mock.calls[0][0].data).not.toHaveProperty("approvedById")
  })

  it("is approved by its creation while segregation of duties is off", async () => {
    h.config.mockResolvedValue({ assetPayoutDualApprovalCents: 100_000_000, requireSegregationOfDuties: false })
    expect(await createPayout(actor, "deal-1")).toEqual({ kind: "created", payoutId: "payout-1", status: "APPROVED" })
    expect(h.create.mock.calls[0][0].data).toMatchObject({ status: "APPROVED", approvedById: "creator-1" })
  })
})
