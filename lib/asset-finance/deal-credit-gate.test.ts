import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RegimeTx } from "./classification"

const m = vi.hoisted(() => ({ loadDealExceptions: vi.fn() }))
vi.mock("./deal-exceptions", () => ({ loadDealExceptions: m.loadDealExceptions }))

import { dealCreditGate } from "./deal-credit-gate"

beforeEach(() => {
  vi.clearAllMocks()
  m.loadDealExceptions.mockResolvedValue({ recorded: [], lines: [] })
})

describe("dealCreditGate", () => {
  it("passes the deal's own booked loan to loadDealExceptions", async () => {
    // Returns loanId only when the query selects it, as the database would.
    const findFirst = vi.fn(async (args: { select: Record<string, unknown> }) => ({
      applicationId: "app-1", entityId: null, clientId: "client-1", approvalExceptions: null,
      ...(args.select.loanId ? { loanId: "loan-booked" } : {}),
      application: { product: { productType: "ASSET_FINANCE" } },
    }))
    const tx = { assetFinanceDeal: { findFirst } } as unknown as RegimeTx
    await dealCreditGate(tx, "tenant-1", "deal-1")
    expect(m.loadDealExceptions).toHaveBeenCalledWith(tx, "tenant-1", expect.objectContaining({ loanId: "loan-booked" }))
  })
})
