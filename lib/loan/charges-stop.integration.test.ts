/**
 * Real-Postgres test of the one-way kill switch: after
 * --disable nothing is derived for the tenant again. Charges clients already
 * paid stay paid, unpaid charges are not collected, readers show none, and
 * --apply refuses to re-enable.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/charges-stop.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { applyChargesBackfill, disableCharges, planChargesBackfill } from "./charges-backfill"
import { sweepTenantCharges } from "./charges-sweep"
import { applyManualReceipt } from "./apply-payment"
import { loanSettlementFigures } from "./charges-summary"
import { createChargesLoan, createChargesTenant, NOW, SCHEDULE_TOTAL } from "./charges.integration-fixture"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const at = (day: string) => vi.setSystemTime(new Date(`${day}T10:00:00+02:00`))

suite.sequential("default charges stopped for good (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })

  it("after --disable: paid charges stay paid, unpaid ones are not collected, and --apply refuses", async () => {
    const tenant = await createChargesTenant(db, true)
    const ids = await createChargesLoan(db, tenant)
    const actor = { userId: tenant.userId, userEmail: "a@test.invalid" }
    const capture = (amount: number) => runWithTenant(tenant.tenantId, () =>
      applyManualReceipt(prisma, { loanId: ids.loanId, tenantId: tenant.tenantId, amount, capturedById: tenant.userId }))

    // Live: R500 on 10 Sep pays Sep 2..9 default interest first; the sweep
    // posts more by the 20th.
    at("2026-09-10")
    const { payment: first } = await capture(50_000)
    at("2026-09-20")
    await runWithTenant(tenant.tenantId, () => sweepTenantCharges(prisma, tenant.tenantId, new Date(), { source: "cron" }))
    const charges = await db.loanCharge.findMany({ where: { loanId: ids.loanId }, orderBy: { day: "asc" } })
    const paidSplit = (await db.payment.findUniqueOrThrow({ where: { id: first.id } })).defaultInterestAllocated
    expect(paidSplit).toBeGreaterThan(0)

    expect(await runWithTenant(tenant.tenantId, () => disableCharges(prisma, tenant.tenantId, new Date(), actor))).toEqual({ changed: true })
    expect(await runWithTenant(tenant.tenantId, () => disableCharges(prisma, tenant.tenantId, new Date(), actor))).toEqual({ changed: false })
    const stoppedAt = new Date("2026-09-20T10:00:00+02:00")
    expect(await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: tenant.tenantId } }))
      .toMatchObject({ defaultChargesEnabled: false, defaultChargesStoppedAt: stoppedAt })
    expect(await db.auditLog.findMany({ where: { tenantId: tenant.tenantId, action: "DEFAULT_CHARGES_DISABLED" } }))
      .toEqual([expect.objectContaining({
        userId: tenant.userId,
        oldValue: { defaultChargesEnabled: true, defaultChargesStartedAt: new Date("2026-01-01T00:00:00+02:00").toISOString(), wasLive: true },
        newValue: { defaultChargesEnabled: false, defaultChargesStoppedAt: stoppedAt.toISOString() },
      })])

    // Stopped: readers show no charges and settlement is the contractual
    // balance alone, so paying it settles the loan with charges left unpaid.
    at("2026-09-26")
    const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, include: { repaymentSchedule: true } })
    const figures = await runWithTenant(tenant.tenantId, () => loanSettlementFigures(prisma, loan, new Date()))
    expect(figures).toMatchObject({ live: false, chargesOutstanding: 0, totalToSettle: SCHEDULE_TOTAL - loan.totalPaid })
    await capture(SCHEDULE_TOTAL - loan.totalPaid)
    const settled = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId } })
    expect(settled).toMatchObject({ status: "COMPLETED", totalPaid: SCHEDULE_TOTAL })

    // Nothing stored moved: the charge rows and the split of the live-era receipt.
    expect(await db.loanCharge.findMany({ where: { loanId: ids.loanId }, orderBy: { day: "asc" } })).toEqual(charges)
    expect((await db.payment.findUniqueOrThrow({ where: { id: first.id } })).defaultInterestAllocated).toBe(paidSplit)
    // The sweep derives nothing for a stopped tenant.
    expect(await runWithTenant(tenant.tenantId, () => sweepTenantCharges(prisma, tenant.tenantId, new Date(), { source: "cron" })))
      .toMatchObject({ changed: 0, failures: [] })

    // --apply and the dry run refuse, writing nothing.
    const auditsBefore = await db.auditLog.count({ where: { tenantId: tenant.tenantId } })
    const refusal = `charges were stopped on ${stoppedAt.toISOString()}; re-enabling is not supported`
    await expect(runWithTenant(tenant.tenantId, () => planChargesBackfill(prisma, tenant.tenantId, new Date()))).rejects.toThrow(refusal)
    await expect(runWithTenant(tenant.tenantId, () => applyChargesBackfill(prisma, tenant.tenantId, new Date(), actor))).rejects.toThrow(refusal)
    expect(await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: tenant.tenantId } }))
      .toMatchObject({ defaultChargesEnabled: false, defaultChargesStoppedAt: stoppedAt })
    expect(await db.auditLog.count({ where: { tenantId: tenant.tenantId } })).toBe(auditsBefore)
    vi.setSystemTime(NOW)
  })

  it("--disable refuses on a tenant whose charges never went live, writing nothing", async () => {
    const tenant = await createChargesTenant(db, false)
    const actor = { userId: tenant.userId, userEmail: "a@test.invalid" }
    await expect(runWithTenant(tenant.tenantId, () => disableCharges(prisma, tenant.tenantId, NOW, actor)))
      .rejects.toThrow("charges were never switched on for this tenant; there is nothing to stop")
    expect(await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: tenant.tenantId } })).toMatchObject({ defaultChargesStoppedAt: null })
    expect(await db.auditLog.count({ where: { tenantId: tenant.tenantId } })).toBe(0)
    // The first --apply still works afterwards.
    await runWithTenant(tenant.tenantId, () => applyChargesBackfill(prisma, tenant.tenantId, NOW, actor))
    expect((await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: tenant.tenantId } })).defaultChargesEnabled).toBe(true)
  })
})
