import { beforeEach, describe, expect, it, vi } from "vitest"

const { loanFindFirst, transaction } = vi.hoisted(() => ({ loanFindFirst: vi.fn(), transaction: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { loan: { findFirst: loanFindFirst }, $transaction: transaction } }))
vi.mock("@/lib/audit", () => ({ AuditAction: new Proxy({}, { get: (_t, key) => String(key) }), logAuditStrict: vi.fn() }))

import { requestSurrender } from "./surrender-store"

const actor = { tenantId: "t1", userId: "u1" }
const loan = (over: { lessorStatus?: string | null; recoveries?: string[] } = {}) => ({
  id: "l1", assetId: "a1", asset: { lessorStatus: over.lessorStatus ?? null }, recoveries: (over.recoveries ?? []).map((status) => ({ status })),
})
const HELD = "The asset is already in the lender's possession"

describe("requestSurrender: the asset must still be the borrower's", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run({ surrenderRequest: { create: vi.fn(async () => ({ id: "s1" })) } }))
  })

  it.each([
    ["a live recovery", { recoveries: ["LISTED"] }],
    ["a recovery that has not been withdrawn, among a withdrawn one", { recoveries: ["WITHDRAWN", "RECOVERED"] }],
    ["an asset the database marks RECOVERED", { lessorStatus: "RECOVERED" }],
    ["an asset sold in remarketing", { lessorStatus: "SOLD_IN_REMARKETING" }],
  ])("refuses with %s, creating nothing", async (_name, over) => {
    loanFindFirst.mockResolvedValue(loan(over))
    expect(await requestSurrender(actor, "l1", "Synthetic: running", "CLIENT")).toEqual({ kind: "not_ready", reason: HELD })
    expect(transaction).not.toHaveBeenCalled()
  })

  it("accepts a loan with no recovery, or only a withdrawn one", async () => {
    for (const recoveries of [[], ["WITHDRAWN"]]) {
      loanFindFirst.mockResolvedValue(loan({ recoveries }))
      expect(await requestSurrender(actor, "l1", "Synthetic: running", "STAFF")).toEqual({ kind: "done", id: "s1" })
    }
  })
})
