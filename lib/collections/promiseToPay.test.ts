import { beforeEach, describe, expect, it, vi } from "vitest"

const { noteFindMany, paymentFindMany } = vi.hoisted(() => ({
  noteFindMany: vi.fn(),
  paymentFindMany: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanNote: { findMany: noteFindMany },
    payment: { findMany: paymentFindMany },
  },
}))

import { getPromiseToPayStatus } from "./promiseToPay"

// The client promised R1 000 on 5 July and paid it that day. Branch cash sat
// on the desk and was only captured on 20 July — well past the 3-day grace.
const RECEIPT = {
  amount: 100_000,
  receivedAt: new Date("2026-07-05T09:00:00.000Z"),
  createdAt: new Date("2026-07-20T09:00:00.000Z"),
}

describe("getPromiseToPayStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    noteFindMany.mockResolvedValue([{
      id: "note-1",
      createdAt: new Date("2026-07-01T09:00:00.000Z"),
      note: JSON.stringify({ promiseAmount: 100_000, promiseDate: "2026-07-05" }),
    }])
    // Applies whichever date field the query actually filtered on, to that same
    // field on the receipt. A query that reverts to `createdAt` therefore
    // genuinely misses this receipt rather than being waved through.
    paymentFindMany.mockImplementation(async (args: {
      where: {
        receivedAt?: { gte: Date; lte: Date }
        createdAt?: { gte: Date; lte: Date }
      }
    }) => {
      const field = args.where.receivedAt ? "receivedAt" : "createdAt"
      const window = args.where[field]
      if (!window) return []
      const value = RECEIPT[field]
      return value >= window.gte && value <= window.lte
        ? [{ amount: RECEIPT.amount }]
        : []
    })
  })

  it("counts a promise as kept from the date the money arrived, not the capture date", async () => {
    const [status] = await getPromiseToPayStatus("loan-1", "tenant-1")

    expect(status.paymentReceived).toBe(100_000)
    expect(status.kept).toBe(true)
  })

  it("still misses a promise the client genuinely never paid", async () => {
    paymentFindMany.mockResolvedValue([])

    const [status] = await getPromiseToPayStatus("loan-1", "tenant-1")

    expect(status.paymentReceived).toBe(0)
    expect(status.kept).toBe(false)
  })

  it("does not let a waived balance keep a promise", async () => {
    await getPromiseToPayStatus("loan-1", "tenant-1")

    expect(paymentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ paymentMethod: { not: "WAIVER" } }),
    }))
  })

  it("scopes the payment lookup to the promise window and the loan's tenant", async () => {
    await getPromiseToPayStatus("loan-1", "tenant-1")

    expect(paymentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: "tenant-1",
        loanId: "loan-1",
        reversed: false,
        allocationStatus: "ALLOCATED",
        receivedAt: {
          gte: new Date("2026-07-01T09:00:00.000Z"),
          lte: new Date("2026-07-08T00:00:00.000Z"),
        },
      }),
    }))
  })
})
