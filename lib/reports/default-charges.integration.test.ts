/**
 * Real-Postgres test of the charges reporting: the "Default charges owing"
 * column (lib/reports/charges-owing.ts) and the Default charges report
 * (lib/reports/default-charges-loader.ts), over rows written by the real
 * receipt, exemption and sweep code.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/reports/default-charges.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import {
  createChargesLoan,
  createChargesTenant,
  DEFAULT_INTEREST,
  NOW,
  SCHEDULE_TOTAL,
  type ChargesTenant,
} from "@/lib/loan/charges.integration-fixture"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({
    error: null,
    user: { id: ctx.userId, email: "charges-it@test.invalid", role: "SUPER_ADMIN" },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
    await runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
}))
vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

import { prisma } from "@/lib/prisma"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { sweepTenantCharges } from "@/lib/loan/charges-sweep"
import { COLLECTIBLE_STATUSES, SETTLED_STATUSES } from "@/lib/loan/collectible-book"
import { PATCH as setExemption } from "@/app/api/loans/[id]/default-charges-exemption/route"
import { loadChargesOwingByBand } from "./charges-owing"
import { boardPackChargesSummary, loadDefaultChargesReport, loadInDuplumSnapshot } from "./default-charges-loader"
import { updateAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const BOOK = [...COLLECTIBLE_STATUSES]
const settledOwing = async (tenantId: string) => (await db.loan.aggregate({
  where: { tenantId, status: { in: [...SETTLED_STATUSES] } }, _sum: { chargesOutstanding: true },
}))._sum.chargesOutstanding ?? 0

async function capture(tenant: ChargesTenant, loanId: string, amount: number) {
  await runWithTenant(tenant.tenantId, () => applyManualReceipt(prisma, {
    loanId, tenantId: tenant.tenantId, amount, capturedById: tenant.userId,
  }))
}

async function exempt(tenant: ChargesTenant, loanId: string) {
  ctx.tenantId = tenant.tenantId
  ctx.userId = tenant.userId
  const req = new NextRequest("http://localhost/api/test", {
    method: "PATCH", body: JSON.stringify({ exempt: true, reason: "Debt review order received." }),
  })
  const res = await setExemption(req, { params: Promise.resolve({ id: loanId }) })
  expect(res.status).toBe(200)
}

suite.sequential("charges reporting (real Postgres)", () => {
  let a: ChargesTenant
  let b: ChargesTenant
  let off: ChargesTenant
  let w: ChargesTenant
  const loans = { paid: "", owing: "", exempted: "", other: "", offLoan: "" }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW })
    a = await createChargesTenant(db)
    b = await createChargesTenant(db)
    off = await createChargesTenant(db, false)
    w = await createChargesTenant(db)
    loans.paid = (await createChargesLoan(db, a)).loanId
    loans.owing = (await createChargesLoan(db, a)).loanId
    loans.exempted = (await createChargesLoan(db, a)).loanId
    loans.other = (await createChargesLoan(db, b)).loanId
    loans.offLoan = (await createChargesLoan(db, off)).loanId

    // R500 pays the R80 of default interest first (s126(3)).
    await capture(a, loans.paid, 50_000)
    // Settled in full with the R80 of default interest, then exempted: the R80
    // nothing now absorbs is owed back.
    await capture(a, loans.exempted, SCHEDULE_TOTAL + DEFAULT_INTEREST)
    await exempt(a, loans.exempted)
    const writtenOff = (await createChargesLoan(db, w)).loanId
    for (const t of [a, b, w]) {
      const swept = await sweepTenantCharges(prisma, t.tenantId, NOW, { source: "reports-it" })
      expect(swept.failures).toEqual([])
    }
    // Charged, then written off: still owed, but outside the collectible book.
    await db.loan.update({ where: { id: writtenOff }, data: { status: "WRITTEN_OFF", writeOffAt: NOW } })
    // A stored figure on a tenant whose charges are not live must never show.
    await db.loan.update({ where: { id: loans.offLoan }, data: { chargesOutstanding: 999, daysInArrears: 25 } })
    // Audit rows are stamped by the database clock; pin them to the test's month.
    await updateAuditRowsForTest(db, { tenantId: a.tenantId }, { createdAt: NOW })
  })
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })

  it("puts charges owing in the loan's DPD band, for this tenant only, and ties to the loans", async () => {
    const owing = await loadChargesOwingByBand(prisma, a.tenantId, BOOK)
    const stored = await db.loan.aggregate({ where: { tenantId: a.tenantId }, _sum: { chargesOutstanding: true } })
    expect(owing.chargesLive).toBe(true)
    expect(owing.byBand["1-30 DPD"]).toBe(DEFAULT_INTEREST)
    expect(owing.total).toBe(DEFAULT_INTEREST)
    expect(owing.total).toBe(stored._sum.chargesOutstanding)
  })

  it("shows no charges owing while charges are not live, whatever the column holds", async () => {
    const owing = await loadChargesOwingByBand(prisma, off.tenantId, BOOK)
    expect(owing).toMatchObject({ chargesLive: false, total: 0, notInArrears: { count: 0, amount: 0 } })
  })

  it("reports the month's accrual, cash collected, outstanding and exemption", async () => {
    const report = await loadDefaultChargesReport(prisma, a.tenantId, NOW)
    expect(report.state).toBe("live")
    expect(report.months).toHaveLength(1)
    expect(report.months[0]).toMatchObject({
      month: "2026-09",
      interest: 2 * DEFAULT_INTEREST, // paid + owing; the exempt loan accrues nothing
      accrued: 2 * DEFAULT_INTEREST,
      collected: DEFAULT_INTEREST,
      waived: 0,
      outstanding: DEFAULT_INTEREST,
      exemptionsSet: 1,
      refundDue: DEFAULT_INTEREST,
    })
    expect(report.rows.map((r) => r.productName)).toEqual(["Micro"])
  })

  it("ties the report to the ledger: outstanding to the loans, collected to the receipt splits", async () => {
    const report = await loadDefaultChargesReport(prisma, a.tenantId, NOW)
    const stored = await db.loan.aggregate({ where: { tenantId: a.tenantId }, _sum: { chargesOutstanding: true } })
    const cash = await db.payment.aggregate({
      where: { tenantId: a.tenantId, reversed: false, allocationStatus: "ALLOCATED", paymentMethod: { not: "WAIVER" } },
      _sum: { defaultInterestAllocated: true, chargeFeesAllocated: true },
    })
    const last = report.months[report.months.length - 1]
    expect(last.outstanding).toBe(stored._sum.chargesOutstanding)
    expect(report.months.reduce((s, m) => s + m.collected, 0))
      .toBe((cash._sum.defaultInterestAllocated ?? 0) + (cash._sum.chargeFeesAllocated ?? 0))
  })

  it("lists the refund due from the exemption, and nothing from another tenant", async () => {
    const report = await loadDefaultChargesReport(prisma, a.tenantId, NOW)
    expect(report.refundsDue).toEqual([
      expect.objectContaining({ loanId: loans.exempted, amount: DEFAULT_INTEREST, source: "exemption", clientName: "Charge Test" }),
    ])
    const other = await loadDefaultChargesReport(prisma, b.tenantId, NOW)
    expect(other.refundsDue).toEqual([])
    expect(other.months[0]).toMatchObject({ accrued: DEFAULT_INTEREST, collected: 0, exemptionsSet: 0 })
  })

  it("gives the board pack this month's line only while charges are live", async () => {
    const owing = await loadChargesOwingByBand(prisma, a.tenantId, BOOK)
    const report = await loadDefaultChargesReport(prisma, a.tenantId, NOW)
    const live = boardPackChargesSummary(report, owing, await settledOwing(a.tenantId), NOW)
    // The three owing parts add up to the report's outstanding over every loan.
    expect(live!.owingInBands + live!.owingNotInArrears + live!.owingElsewhere).toBe(report.months.at(-1)!.outstanding)
    expect(live).toEqual({
      accrued: 2 * DEFAULT_INTEREST, collected: DEFAULT_INTEREST,
      owingInBands: DEFAULT_INTEREST, owingNotInArrears: 0, owingElsewhere: 0,
      exemptionRefunds: { count: 1, amount: DEFAULT_INTEREST },
    })
    const wOwing = await loadChargesOwingByBand(prisma, w.tenantId, BOOK)
    const wReport = await loadDefaultChargesReport(prisma, w.tenantId, NOW)
    expect(wReport.months.at(-1)!.outstanding).toBe(DEFAULT_INTEREST)
    expect(boardPackChargesSummary(wReport, wOwing, await settledOwing(w.tenantId), NOW)).toMatchObject({
      owingInBands: 0, owingNotInArrears: 0, owingElsewhere: DEFAULT_INTEREST,
    })
    const never = await loadDefaultChargesReport(prisma, off.tenantId, NOW)
    expect(never.state).toBe("never")
    expect(boardPackChargesSummary(never, await loadChargesOwingByBand(prisma, off.tenantId, BOOK), 0, NOW)).toBeNull()
  })

  it("lists a loan at the in duplum cap, and not before it gets there", async () => {
    expect(await loadInDuplumSnapshot(prisma, a.tenantId, NOW)).toEqual([])
    // Default interest on R2,000 at 5% a month reaches the cap well inside two years.
    const later = await loadInDuplumSnapshot(prisma, a.tenantId, new Date("2028-09-01T10:00:00+02:00"))
    const ids = later.map((r) => r.loanId)
    expect(ids).toContain(loans.owing)
    expect(ids).not.toContain(loans.exempted)
    expect(later.find((r) => r.loanId === loans.owing)).toMatchObject({ capBase: 200_000, productName: "Micro" })
    expect(await loadInDuplumSnapshot(prisma, off.tenantId, new Date("2028-09-01T10:00:00+02:00"))).toEqual([])
  })
})
