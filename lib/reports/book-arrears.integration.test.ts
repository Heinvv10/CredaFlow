/**
 * Real-Postgres test that every screen stating book, arrears and PAR gives the
 * same numbers on one book: the dashboard and collections (getBookArrears), the
 * sidebar badge (countLoansInArrears), the board pack (getPortfolioPar) and the
 * NCR return (getNcrReturnData, NCA scope).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/reports/book-arrears.integration.test.ts
 */
import { PrismaClient, type LoanStatus } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createRepriceLoan, createRepriceTenant } from "@/lib/asset-finance/reprice.integration-fixture"
import { countLoansInArrears, getBookArrears, overdueBandWhere, overdueWhere } from "./book-arrears"
import { collectionsQueueWhere } from "@/lib/collections/queue"
import { getPortfolioPar } from "./par"
import { getNcrReturnData } from "@/lib/compliance/ncr-return"
import { currentQuarter } from "@/lib/compliance/quarters"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

interface Shape { status: LoanStatus; dpd: number; arrears: number; outstanding: number; charges?: number }

suite.sequential("book, arrears and PAR — one helper for every screen (real Postgres)", () => {
  let tenantId = ""
  let liveTenantId = ""
  let entityOutstanding = 0

  beforeAll(async () => {
    const tenant = await createRepriceTenant(db)
    tenantId = tenant.tenantId
    const fx = { tenantId, userId: tenant.adminId, productId: tenant.productId }
    const shapes: Shape[] = [
      { status: "ACTIVE", dpd: 45, arrears: 50_000, outstanding: 150_000 },
      { status: "DEFAULTED", dpd: 120, arrears: 200_000, outstanding: 180_000 },
      { status: "ACTIVE", dpd: 0, arrears: 0, outstanding: 200_000 }, // current
      // A stale DPD with nothing unpaid is not in arrears.
      { status: "ACTIVE", dpd: 10, arrears: 0, outstanding: 200_000 },
      { status: "PENDING_WRITE_OFF", dpd: 95, arrears: 30_000, outstanding: 100_000 },
      // Settled: outside the book whatever its stale ageing says.
      { status: "COMPLETED", dpd: 40, arrears: 5_000, outstanding: 0 },
      // Fully repaid principal carrying stale arrears (audit N-03/N-05).
      { status: "ACTIVE", dpd: 35, arrears: 10_000, outstanding: 0 },
    ]
    for (const shape of shapes) {
      const { loanId } = await createChargesLoan(db, fx)
      await db.loan.update({
        where: { id: loanId },
        data: { status: shape.status, daysInArrears: shape.dpd, arrearsAmount: shape.arrears, outstandingPrincipal: shape.outstanding },
      })
    }
    // A NON_NCA asset-finance loan in arrears: on the operational screens, not on the NCR return.
    const entityLoanId = await createRepriceLoan(db, tenant)
    const entityLoan = await db.loan.update({
      where: { id: entityLoanId },
      data: { daysInArrears: 65, arrearsAmount: 1_000_000 },
    })
    entityOutstanding = entityLoan.outstandingPrincipal

    // Charges live: a paid schedule with default charges owed is in arrears too.
    const live = await createChargesTenant(db)
    liveTenantId = live.tenantId
    const { loanId } = await createChargesLoan(db, live)
    await db.loan.update({ where: { id: loanId }, data: { daysInArrears: 0, arrearsAmount: 0, chargesOutstanding: 8_000 } })
    const { loanId: overdue } = await createChargesLoan(db, live)
    await db.loan.update({ where: { id: overdue }, data: { daysInArrears: 31, arrearsAmount: 20_000, chargesOutstanding: 1_000 } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  it("states the book, arrears and PAR by the labelled definitions", async () => {
    const all = await getBookArrears(tenantId, "ALL")
    const ncaBook = 150_000 + 180_000 + 200_000 + 200_000 + 100_000 + 0
    expect(all.book).toEqual({ count: 7, value: ncaBook + entityOutstanding })
    expect(all.arrears).toEqual({
      count: 4,
      amount: 50_000 + 200_000 + 30_000 + 1_000_000,
      outstandingPrincipal: 150_000 + 180_000 + 100_000 + entityOutstanding,
    })
    expect(all.par30).toMatchObject({ count: 4, value: 150_000 + 180_000 + 100_000 + entityOutstanding })
    expect(all.par60).toMatchObject({ count: 3, value: 180_000 + 100_000 + entityOutstanding })
    expect(all.par90).toMatchObject({ count: 2, value: 180_000 + 100_000 })
    expect(all.par30.pct).toBeCloseTo((all.par30.value / all.book.value) * 100, 10)

    const nca = await getBookArrears(tenantId, "NCA")
    expect(nca.book).toEqual({ count: 6, value: ncaBook })
    expect(nca.arrears).toEqual({ count: 3, amount: 280_000, outstandingPrincipal: 430_000 })
    expect(nca.par60).toMatchObject({ count: 2, value: 280_000 })
  })

  it("gives the sidebar badge the dashboard's and collections page's count", async () => {
    expect(await countLoansInArrears(tenantId)).toBe((await getBookArrears(tenantId)).arrears.count)
  })

  it("gives the board pack the dashboard's PAR", async () => {
    const all = await getBookArrears(tenantId)
    expect(await getPortfolioPar(tenantId)).toEqual({ book: all.book.value, par30: all.par30, par60: all.par60, par90: all.par90 })
  })

  it("gives the NCR return the same book, arrears and PAR, on the NCA scope", async () => {
    const now = new Date()
    const ncr = await getNcrReturnData(tenantId, currentQuarter(now), now)
    const nca = await getBookArrears(tenantId, "NCA")
    const line = (key: string) => ncr.lines.find((l) => l.key === key)
    expect(ncr.collectibleBook).toEqual(nca.book)
    expect(line("book")).toMatchObject({ count: nca.book.count, value: nca.book.value })
    expect(line("arrears")).toMatchObject({ count: nca.arrears.count, value: nca.arrears.amount })
    for (const key of ["par30", "par60", "par90"] as const) {
      expect(line(key)).toMatchObject({ count: nca[key].count, value: nca[key].value, percentOfBook: nca[key].pct })
    }
  })

  it("ages the same accounts it counts in arrears, and lists them for the board pack and exports", async () => {
    const all = await getBookArrears(tenantId)
    expect(all.ageing.reduce((sum, band) => sum + band.count, 0)).toBe(all.arrears.count)
    expect(all.ageing.reduce((sum, band) => sum + band.arrearsAmount, 0)).toBe(all.arrears.amount)
    expect(all.ageing.map((band) => band.count)).toEqual([0, 1, 1, 2])
    // The board pack's arrears list and the PAR / collections exports read these wheres.
    expect(await db.loan.count({ where: overdueWhere(tenantId) })).toBe(all.arrears.count)
    expect(await db.loan.count({ where: overdueBandWhere(tenantId, 30) })).toBe(all.par30.count)
  })

  it("keeps an account owing only default charges out of the days-past-due figures, and states it beside them", async () => {
    const live = await getBookArrears(liveTenantId)
    expect(live.chargesLive).toBe(true)
    expect(live.arrears).toMatchObject({ count: 1, amount: 20_000 + 1_000 })
    expect(live.chargesOnly).toEqual({ count: 1, amount: 8_000 })
    expect(live.par30.count).toBe(1)
    // The collections queue and the sidebar badge work both.
    expect(await countLoansInArrears(liveTenantId)).toBe(2)
    expect(await db.loan.count({ where: collectionsQueueWhere(liveTenantId, true) })).toBe(2)
    // The regulator's "1+ days" line is days past due only.
    const now = new Date()
    const ncr = await getNcrReturnData(liveTenantId, currentQuarter(now), now)
    expect(ncr.lines.find((l) => l.key === "arrears")).toMatchObject({ count: 1, value: 21_000 })
    expect(ncr.lines.find((l) => l.key === "chargesOnly")).toMatchObject({ count: 1, value: 8_000 })
  })
})
