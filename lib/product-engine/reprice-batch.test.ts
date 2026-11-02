import { beforeEach, describe, expect, it, vi } from "vitest"

const { prisma, repriceLoan } = vi.hoisted(() => ({
  prisma: { referenceRate: { findMany: vi.fn() }, loan: { findMany: vi.fn() }, $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})) },
  repriceLoan: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({ prisma }))
vi.mock("./reprice-loan", () => ({ repriceLoan }))

import { repriceTenantLoans } from "./reprice-batch"

const value = (day: string, rate: number, basis = "PRIME") => ({ basis, effectiveDate: new Date(`${day}T00:00:00Z`), rate: { toNumber: () => rate } })
const loan = (id: string, onDay: string, basis = "PRIME") => ({ id, terms: [{ rateBasis: basis, referenceEffectiveDate: new Date(`${onDay}T00:00:00Z`) }] })

beforeEach(() => {
  vi.clearAllMocks()
  repriceLoan.mockResolvedValue({ kind: "repriced" })
  prisma.loan.findMany.mockResolvedValue([])
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("repriceTenantLoans", () => {
  it("reads only approved values of the variable bases effective by today, oldest first", async () => {
    prisma.referenceRate.findMany.mockResolvedValue([])
    await repriceTenantLoans("t", "2027-04-01")
    expect(prisma.referenceRate.findMany.mock.calls[0]![0]).toMatchObject({
      where: { tenantId: "t", status: "APPROVED", basis: { in: ["PRIME", "LENDER_BASE"] }, effectiveDate: { lte: new Date("2027-04-01T00:00:00Z") } }, orderBy: { effectiveDate: "asc" },
    })
  })

  it("applies each value after the one the loan is on, in order, on its own basis only", async () => {
    prisma.referenceRate.findMany.mockResolvedValue([value("2027-01-01", 0.08), value("2027-02-01", 0.09), value("2027-02-15", 0.2, "LENDER_BASE"), value("2027-03-01", 0.1)])
    prisma.loan.findMany.mockResolvedValue([loan("l1", "2027-01-01")])
    expect(await repriceTenantLoans("t", "2027-04-01")).toMatchObject({ repriced: 2 })
    expect(repriceLoan.mock.calls.map((c) => c[1].reference.effectiveDate)).toEqual(["2027-02-01", "2027-03-01"])
  })

  it("stops a loan at its first failure, so a later value cannot bury the one it missed, and goes on to the next loan", async () => {
    prisma.referenceRate.findMany.mockResolvedValue([value("2027-02-01", 0.09), value("2027-03-01", 0.1)])
    prisma.loan.findMany.mockResolvedValue([loan("l1", "2027-01-01"), loan("l2", "2027-01-01")])
    repriceLoan.mockRejectedValueOnce(new Error("boom"))
    expect(await repriceTenantLoans("t", "2027-04-01")).toMatchObject({ failed: 1, repriced: 2 })
    expect(repriceLoan.mock.calls.map((c) => c[1].loanId)).toEqual(["l1", "l2", "l2"])
  })
})
