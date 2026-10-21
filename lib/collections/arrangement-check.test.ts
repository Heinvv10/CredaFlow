import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  tenants: [{ id: "t1", name: "One" }, { id: "t2", name: "Two" }],
  arrangementFindMany: vi.fn(),
  arrangementUpdateMany: vi.fn(),
  paymentFindMany: vi.fn(),
  noteCreate: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findMany: async () => m.tenants },
    paymentArrangement: { findMany: m.arrangementFindMany, updateMany: m.arrangementUpdateMany },
    payment: { findMany: m.paymentFindMany },
    loanNote: { create: m.noteCreate },
  },
}))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }))

import { runArrangementCheck } from "./arrangement-check"

const DAY = 86_400_000
/** A weekly arrangement that ran from 60 to 30 days ago with no payment received: BROKEN. */
const broken = (loanId: string) => ({ loanId, agreedAmount: 50_000, frequency: "WEEKLY", startDate: new Date(Date.now() - 60 * DAY), endDate: new Date(Date.now() - 30 * DAY) })

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  m.tenants.splice(0, m.tenants.length, { id: "t1", name: "One" }, { id: "t2", name: "Two" })
  m.arrangementFindMany.mockImplementation(async (a: { where: { tenantId: string } }) => [broken(`loan_${a.where.tenantId}`)])
  m.arrangementUpdateMany.mockResolvedValue({ count: 1 })
  m.paymentFindMany.mockResolvedValue([])
  m.noteCreate.mockResolvedValue({})
})

describe("runArrangementCheck", () => {
  it("settles each ACTIVE tenant's arrangements, not only the first", async () => {
    const r = await runArrangementCheck()
    expect(r).toMatchObject({ tenants: 2, broken: 2, failed: 0, failedTenants: 0 })
    expect(m.arrangementFindMany.mock.calls.map((c) => c[0].where.tenantId)).toEqual(["t1", "t2"])
  })

  // PaymentArrangement.loanId is unique, so a loan has no earlier arrangement to protect; the guard
  // is for the gap between the read and the write: a status staff set meanwhile is not overwritten.
  it("writes only while the arrangement is still ACTIVE", async () => {
    await runArrangementCheck()
    for (const [args] of m.arrangementUpdateMany.mock.calls) expect(args.where).toMatchObject({ status: "ACTIVE" })
  })

  it("does not note or count a verdict that staff overtook since the read", async () => {
    m.arrangementUpdateMany.mockResolvedValue({ count: 0 })
    const r = await runArrangementCheck()
    expect(r).toMatchObject({ broken: 0, failed: 0 })
    expect(m.noteCreate).not.toHaveBeenCalled()
  })

  it("counts an update that failed, and still settles the rest", async () => {
    m.arrangementUpdateMany.mockRejectedValueOnce(new Error("deadlock")).mockResolvedValue({ count: 1 })
    const r = await runArrangementCheck()
    expect(r).toMatchObject({ failed: 1, broken: 1, failedTenants: 0 })
  })

  it("counts a tenant that threw, and runs the next", async () => {
    m.arrangementFindMany.mockRejectedValueOnce(new Error("connection reset"))
    const r = await runArrangementCheck()
    expect(r).toMatchObject({ failedTenants: 1, broken: 1 })
  })
})
