import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    complaint: { findFirst: vi.fn() },
    creditBureauCheck: { findFirst: vi.fn() },
  },
}))

import { prisma } from "@/lib/prisma"
import { dunningHoldReason } from "./dunning-holds"

const loan = {
  status: "DEFAULTED" as const,
  ncaRegime: "NCA" as const,
  daysInArrears: 7,
  arrearsAmount: 100,
  outstandingPrincipal: 100,
  clientId: "c1",
  collectionsStage: "NONE" as const,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.complaint.findFirst).mockResolvedValue(null)
  vi.mocked(prisma.creditBureauCheck.findFirst).mockResolvedValue(null)
})

describe("dunningHoldReason", () => {
  it("returns null for an ordinary arrears loan", async () => {
    expect(await dunningHoldReason("t1", loan)).toBeNull()
  })

  it("holds a loan the dunning eligibility policy refuses", async () => {
    expect(await dunningHoldReason("t1", { ...loan, status: "WRITTEN_OFF" })).toMatch(/not eligible/)
  })

  it.each(["ATTORNEY_REFERRED", "PAYMENT_ARRANGEMENT", "WRITTEN_OFF"] as const)("holds collections stage %s", async (collectionsStage) => {
    expect(await dunningHoldReason("t1", { ...loan, collectionsStage })).toContain(collectionsStage)
  })

  it("holds a client with an open complaint", async () => {
    vi.mocked(prisma.complaint.findFirst).mockResolvedValue({ id: "cmp1" } as never)
    expect(await dunningHoldReason("t1", loan)).toMatch(/complaint/)
    expect(prisma.complaint.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "t1", clientId: "c1" }),
    }))
  })

  it("holds a client the latest bureau check flags as under debt review", async () => {
    vi.mocked(prisma.creditBureauCheck.findFirst).mockResolvedValue({ underDebtReview: true } as never)
    expect(await dunningHoldReason("t1", loan)).toMatch(/debt review/)
  })

  it("an entity borrower (no client) skips the client-level checks", async () => {
    expect(await dunningHoldReason("t1", { ...loan, clientId: null })).toBeNull()
    expect(prisma.complaint.findFirst).not.toHaveBeenCalled()
  })
})
