/**
 * s126(3) on a real database: with charges live, a receipt pays all due
 * interest, then all due fees and charges, then principal, and the booked
 * schedule and Loan.outstandingPrincipal say so.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/charges-s126.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { recomputeLoanBalances } from "./balances"
import { createChargesLoan, createChargesTenant, NOW } from "./charges.integration-fixture"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({ error: null, user: { id: ctx.userId, email: "s126@test.invalid", role: "SUPER_ADMIN" } })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
    await runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
}))
vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

import { prisma as payments } from "@/lib/prisma"
import { applyManualReceipt } from "./apply-payment"
import { applyChargesBackfill, planChargesBackfill } from "./charges-backfill"
import { loadChargesReplay } from "./charges-replay"
import { sweepTenantCharges } from "./charges-sweep"
import { PATCH as reverse } from "@/app/api/payments/[id]/reverse/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

type Ids = Awaited<ReturnType<typeof createChargesLoan>>
const at = (day: string) => new Date(`${day}T10:00:00+02:00`)

/** Re-books the fixture loan as a REDUCING_BALANCE loan with these instalments. */
async function reducingBalance(ids: Ids, rows: Array<{ due: string; principalDue: number; interestDue: number; feesDue: number }>, interestRatePm = 0.05) {
  await db.repaymentSchedule.deleteMany({ where: { loanId: ids.loanId } })
  await db.repaymentSchedule.createMany({
    data: rows.map((row, i) => ({
      tenantId: ids.tenantId, loanId: ids.loanId, installmentNo: i + 1, dueDate: at(row.due),
      principalDue: row.principalDue, interestDue: row.interestDue, feesDue: row.feesDue,
      totalDue: row.principalDue + row.interestDue + row.feesDue,
    })),
  })
  const totalInterest = rows.reduce((sum, row) => sum + row.interestDue, 0)
  await db.loan.update({
    where: { id: ids.loanId },
    data: {
      interestModel: "REDUCING_BALANCE", interestRatePm, totalInterest, maturityDate: at(rows.at(-1)!.due),
      totalRepayable: rows.reduce((sum, row) => sum + row.principalDue + row.interestDue + row.feesDue, 0),
    },
  })
}

const capture = (ids: Ids, amount: number) => runWithTenant(ids.tenantId, () =>
  applyManualReceipt(payments, { loanId: ids.loanId, tenantId: ids.tenantId, amount, capturedById: ids.userId }))

const bookedRows = async (ids: Ids) =>
  (await db.repaymentSchedule.findMany({ where: { loanId: ids.loanId }, orderBy: { dueDate: "asc" } })).map((row) => row.totalPaid)

suite.sequential("s126(3) receipt order (real DB)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })

  it("pays the second overdue instalment's interest and fees before the first one's principal", async () => {
    const ids = await createChargesLoan(db, await createChargesTenant(db))
    // Two instalments of R1,000 principal + R50 interest + R34.50 fees, both overdue.
    const instalment = { principalDue: 100_000, interestDue: 5_000, feesDue: 3_450, totalDue: 108_450 }
    await db.repaymentSchedule.updateMany({
      where: { loanId: ids.loanId },
      data: { ...instalment, dueDate: new Date("2026-08-15T10:00:00+02:00") },
    })
    await db.repaymentSchedule.create({
      data: { tenantId: ids.tenantId, loanId: ids.loanId, installmentNo: 2, dueDate: new Date("2026-09-01T10:00:00+02:00"), ...instalment },
    })

    await runWithTenant(ids.tenantId, () => applyManualReceipt(payments, {
      loanId: ids.loanId, tenantId: ids.tenantId, amount: 110_000, capturedById: ids.userId,
    }))

    const payment = await db.payment.findFirstOrThrow({ where: { loanId: ids.loanId } })
    const loan = await db.loan.findUniqueOrThrow({
      where: { id: ids.loanId }, include: { repaymentSchedule: { orderBy: { dueDate: "asc" } } },
    })
    const defaultInterest = payment.defaultInterestAllocated
    expect(defaultInterest).toBeGreaterThan(0)
    expect(payment.chargeFeesAllocated).toBe(0)
    // Default interest, both instalments' interest and fees, then principal.
    const principal = 110_000 - defaultInterest - 2 * (5_000 + 3_450)
    expect(loan.repaymentSchedule.map((row) => row.totalPaid)).toEqual([8_450 + principal, 8_450])
    expect(loan.outstandingPrincipal).toBe(200_000 - principal)
    expect(recomputeLoanBalances(loan.principal, loan.repaymentSchedule, new Date()).outstandingPrincipal)
      .toBe(loan.outstandingPrincipal)
    expect(loan.totalPaid).toBe(110_000 - defaultInterest)

    // A second receipt completing instalment 1 is the date it was paid.
    await runWithTenant(ids.tenantId, () => applyManualReceipt(payments, {
      loanId: ids.loanId, tenantId: ids.tenantId, amount: 100_000 - principal, capturedById: ids.userId,
    }))
    const second = await db.payment.findFirstOrThrow({ where: { loanId: ids.loanId, id: { not: payment.id } } })
    const rows = await db.repaymentSchedule.findMany({ where: { loanId: ids.loanId }, orderBy: { dueDate: "asc" } })
    expect(rows.map((row) => [row.totalPaid, row.paidAt])).toEqual([[108_450, second.receivedAt], [8_450, null]])
  })

  it("REDUCING_BALANCE, two instalments overdue: capture, capture, reversal and the nightly sync are never refused and book the s126(3) split", async () => {
    const ids = await createChargesLoan(db, await createChargesTenant(db))
    ctx.tenantId = ids.tenantId
    ctx.userId = ids.userId
    await reducingBalance(ids, [
      { due: "2026-08-15", principalDue: 66_667, interestDue: 5_000, feesDue: 3_450 },
      { due: "2026-09-15", principalDue: 66_667, interestDue: 3_300, feesDue: 3_450 },
      { due: "2026-10-15", principalDue: 66_666, interestDue: 1_700, feesDue: 3_450 },
    ])
    await capture(ids, 50_000)
    await capture(ids, 30_000)
    const first = await db.payment.findFirstOrThrow({ where: { loanId: ids.loanId, amount: 50_000 } })
    const res = await reverse(
      new NextRequest("http://localhost/api/test", { method: "PATCH", body: JSON.stringify({ reason: "Bounced" }) }),
      { params: Promise.resolve({ id: first.id }) },
    )
    expect(res.status).toBe(200)
    // The nightly cron's sweep: re-derives the loan without refusing it.
    const swept = await runWithTenant(ids.tenantId, () =>
      sweepTenantCharges(payments, ids.tenantId, NOW, { source: "cron:default-charges" }))
    expect(swept.failures).toEqual([])

    const loan = await db.loan.findUniqueOrThrow({
      where: { id: ids.loanId }, include: { repaymentSchedule: { orderBy: { dueDate: "asc" } } },
    })
    const replay = await runWithTenant(ids.tenantId, () =>
      loadChargesReplay(payments, { tenantId: ids.tenantId, loanId: ids.loanId }, NOW))
    const rows = loan.repaymentSchedule.map((row) => row.totalPaid)
    expect(rows).toEqual(replay!.result.scheduleRows.map((row) => row.paid))
    // The R300 left pays default interest, both overdue instalments' interest
    // and fees, then instalment 1's principal: instalment 2's interest and
    // fees are paid while instalment 1's principal is not.
    const live = await db.payment.findMany({ where: { loanId: ids.loanId, reversed: false } })
    expect(live.map((p) => p.amount)).toEqual([30_000])
    const principal = 30_000 - live[0].defaultInterestAllocated - (5_000 + 3_450) - (3_300 + 3_450)
    expect(live[0].defaultInterestAllocated).toBeGreaterThan(0)
    expect(principal).toBeGreaterThan(0)
    expect(loan.repaymentSchedule.map((row) => [row.totalPaid, row.status])).toEqual([
      [5_000 + 3_450 + principal, "PARTIAL"], [3_300 + 3_450, "PARTIAL"], [0, "PENDING"],
    ])
    expect([loan.outstandingPrincipal, loan.daysInArrears]).toEqual([200_000 - principal, 42])
    const cashLessCharges = live.reduce((sum, p) => sum + p.amount - p.defaultInterestAllocated - p.chargeFeesAllocated, 0)
    expect([rows.reduce((sum, paid) => sum + paid, 0), cashLessCharges]).toEqual([loan.totalPaid, loan.totalPaid])
    expect(loan.outstandingPrincipal).toBe(recomputeLoanBalances(loan.principal, loan.repaymentSchedule, NOW).outstandingPrincipal)
  })

  it("first go-live lists a loan whose booked instalment split s126(3) changes, and applies it only once accepted", async () => {
    const tenant = await createChargesTenant(db, false)
    const ids = await createChargesLoan(db, tenant)
    // No default interest (rate 0), so the ONLY change is the split between instalments.
    await reducingBalance(ids, [
      { due: "2026-08-15", principalDue: 100_000, interestDue: 5_000, feesDue: 3_450 },
      { due: "2026-09-01", principalDue: 100_000, interestDue: 5_000, feesDue: 3_450 },
    ], 0)
    // Booked before go-live, instalment by instalment: R1,084.50 then R15.50.
    await db.payment.create({ data: { tenantId: ids.tenantId, loanId: ids.loanId, amount: 110_000, receivedAt: at("2026-09-20") } })
    await db.loan.update({ where: { id: ids.loanId }, data: { totalPaid: 110_000, outstandingPrincipal: 100_000 } })
    await db.repaymentSchedule.updateMany({ where: { loanId: ids.loanId, installmentNo: 1 }, data: { totalPaid: 108_450, status: "PAID" } })
    await db.repaymentSchedule.updateMany({ where: { loanId: ids.loanId, installmentNo: 2 }, data: { totalPaid: 1_550, status: "PARTIAL" } })
    const actor = { userId: ids.userId, userEmail: "a@test.invalid" }

    const plan = await runWithTenant(ids.tenantId, () => planChargesBackfill(payments, ids.tenantId, NOW))
    expect(plan.needsAcceptance.map((n) => [n.loanId, n.changes])).toEqual([[ids.loanId, ["reallocates_instalments"]]])
    await expect(runWithTenant(ids.tenantId, () => applyChargesBackfill(payments, ids.tenantId, NOW, actor)))
      .rejects.toThrow(/need acceptance/)
    expect(await bookedRows(ids)).toEqual([108_450, 1_550])

    await runWithTenant(ids.tenantId, () => applyChargesBackfill(payments, ids.tenantId, NOW, actor, { accept: [ids.loanId] }))
    // Both instalments' interest and fees, then R931 of instalment 1's principal.
    expect(await bookedRows(ids)).toEqual([101_550, 8_450])
    const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId } })
    expect([loan.totalPaid, loan.outstandingPrincipal]).toEqual([110_000, 200_000 - 93_100])
    // Once applied, a re-run has nothing left to accept.
    const again = await runWithTenant(ids.tenantId, () => planChargesBackfill(payments, ids.tenantId, NOW))
    expect(again.needsAcceptance).toEqual([])
  })
})
