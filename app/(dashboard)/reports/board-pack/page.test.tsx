import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"
import { overdueBandWhere, overdueWhere } from "@/lib/reports/book-arrears"

// Every Prisma call is recorded; reads answer empty unless a test says otherwise.
const { calls, answers } = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; args: Record<string, unknown> }>,
  answers: new Map<string, unknown | ((args: Record<string, unknown>) => unknown)>(),
}))
const empty: Record<string, unknown> = { aggregate: { _count: 0, _sum: {} }, findMany: [], groupBy: [], count: 0 }
const model = (name: string) => new Proxy({}, {
  get: (_, method: string) => async (args: Record<string, unknown>) => {
    const op = `${name}.${method}`
    calls.push({ op, args })
    const answer = answers.get(op)
    return (typeof answer === "function" ? answer(args) : answer) ?? empty[method]
  },
})

vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get: (_, name: string) => model(name) }),
}))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => "tenant-1") }))
vi.mock("@/lib/config/identity", () => ({
  getLenderBrandName: vi.fn(async () => "Acme Lending"),
  findLenderIdentity: vi.fn(async () => ({ ncrNumber: "NCRCP99999" })),
}))
// The book and PAR as every screen states them; the where-builders stay real.
const { getBookArrears } = vi.hoisted(() => ({ getBookArrears: vi.fn() }))
vi.mock("@/lib/reports/book-arrears", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reports/book-arrears")>()),
  getBookArrears,
}))
const zero = { value: 0, pct: 0, count: 0 }
const bookOf = (count: number, value: number) => ({
  scope: "ALL", chargesLive: false, book: { count, value }, arrears: { count: 0, amount: 0, outstandingPrincipal: 0 },
  chargesOnly: { count: 0, amount: 0 }, ageing: [], par30: zero, par60: zero, par90: zero,
})
vi.mock("@/lib/reports/charges-owing", () => ({
  chargesOwing: () => 0,
  loadChargesOwingByBand: vi.fn(async () => ({ chargesLive: false, byBand: {}, notInArrears: { count: 0, amount: 0 }, total: 0 })),
}))

import BoardPackPage from "./page"

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

describe("Board pack", () => {
  beforeEach(() => {
    calls.length = 0
    answers.clear()
    getBookArrears.mockResolvedValue(bookOf(0, 0))
  })

  it("states the collectible book from the shared helper as the Loan Book, with no aggregate of its own", async () => {
    getBookArrears.mockResolvedValue(bookOf(7, 2_620_000_00))
    const html = text(renderToStaticMarkup(await BoardPackPage()))
    expect(getBookArrears).toHaveBeenCalledWith("tenant-1")
    expect(html).toContain("Loan Book R 2,620,000.00 7 loans in the collectible book")
    const bookAggregates = calls.filter((c) => c.op === "loan.aggregate" && "outstandingPrincipal" in ((c.args._sum ?? {}) as object))
    expect(bookAggregates).toEqual([])
  })

  it("leaves a reversed loan's CANCELLED instalments out of the collection-rate denominator", async () => {
    calls.length = 0
    await BoardPackPage()
    const expected = calls.find((c) => c.op === "repaymentSchedule.aggregate")
    expect((expected?.args.where as { status?: unknown }).status).toEqual({ not: "CANCELLED" })
  })

  it("ranks the top 10 over the collectible book only, with a stable tie-break", async () => {
    await BoardPackPage()
    const top = calls.find((c) => c.op === "loan.findMany" && c.args.take === 10)
    expect(top?.args.where).toEqual({ tenantId: "tenant-1", status: { in: [...COLLECTIBLE_STATUSES] } })
    expect(top?.args.orderBy).toEqual([{ principal: "desc" }, { reference: "asc" }])
  })

  it("counts as active clients only those with an active loan", async () => {
    answers.set("client.count", 42)
    const html = text(renderToStaticMarkup(await BoardPackPage()))
    expect(calls.find((c) => c.op === "client.count")?.args.where).toEqual({ tenantId: "tenant-1", loans: { some: { status: "ACTIVE" } } })
    expect(html).toContain("Active Clients 42 With an active loan")
  })

  it("rates arrears as principal in arrears over the collectible book, never arrears amounts over principal", async () => {
    // Book R10,000; two accounts in arrears with R2,000 principal between them,
    // owing R2,600 of instalments (interest and fees included).
    getBookArrears.mockResolvedValue(bookOf(5, 1_000_000))
    // The accounts in arrears as every screen counts them (lib/reports/book-arrears.ts).
    answers.set("loan.findMany", (args: Record<string, unknown>) =>
      JSON.stringify(args.where) === JSON.stringify(overdueWhere("tenant-1"))
        ? [
            { daysInArrears: 5, arrearsAmount: 130_000, outstandingPrincipal: 100_000 },
            { daysInArrears: 12, arrearsAmount: 130_000, outstandingPrincipal: 100_000 },
          ]
        : undefined)
    const html = text(renderToStaticMarkup(await BoardPackPage()))
    expect(html).toContain("Arrears Rate 20.0% Principal of accounts in arrears ÷ collectible book; R 2,600.00 unpaid instalments")
  })

  it("lists the top delinquent accounts from the book's 30+ days in arrears", async () => {
    await BoardPackPage()
    const top = calls.find((c) => c.op === "loan.findMany" && c.args.take === 5)
    expect(top?.args.where).toEqual(overdueBandWhere("tenant-1", 30))
  })

  it("offers no month to pick and dates itself as at today, because every figure is live", async () => {
    const html = renderToStaticMarkup(await BoardPackPage())
    expect(html).not.toContain("<select")
    expect(text(html)).toContain("Board Pack — as at")
    expect(text(html)).not.toMatch(/Board Pack — (January|February|March|April|May|June|July|August|September|October|November|December)/)
  })
})
