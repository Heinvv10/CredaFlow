/**
 * Real-Postgres proof that the DPD update is tenant-isolated: one tenant's pass
 * recomputes, defaults (90 DPD) and claws back commission on its own loans and
 * touches nothing of another tenant's, and that escalations/reminders can make
 * sure a tenant's DPD is current (ensureDpdCurrent) without running the others.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/dpd-update.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { cronDoneToday } from "@/lib/ops/cron-run-claim"
import { runWithTenant } from "@/lib/tenant-scope"
import { prisma } from "@/lib/prisma"
import { ensureDpdCurrent, updateTenantDpd } from "@/lib/loan/dpd-update"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

const STALE = { daysInArrears: 7, arrearsAmount: 12_345 }
let a: ChargesTenant
let b: ChargesTenant
let loanA: string
let loanB: string

/** A loan whose only instalment fell due 120 days ago: 90+ DPD, with a pending referral commission and deliberately stale figures. */
async function seedDefaultingLoan(tenant: ChargesTenant): Promise<string> {
  const { loanId } = await createChargesLoan(db, tenant)
  await db.repaymentSchedule.updateMany({ where: { loanId }, data: { dueDate: new Date(Date.now() - 120 * 86_400_000) } })
  await db.loan.update({ where: { id: loanId }, data: STALE })
  await db.referralEvent.create({
    data: { tenantId: tenant.tenantId, eventType: "CONVERTED", commissionStatus: "PENDING", commissionCents: 1000, metadata: { loanId } },
  })
  return loanId
}
const loanOf = (id: string) => db.loan.findUniqueOrThrow({ where: { id }, select: { status: true, daysInArrears: true, arrearsAmount: true, updatedAt: true } })
const commissionOf = async (loanId: string) =>
  (await db.referralEvent.findFirstOrThrow({ where: { metadata: { path: ["loanId"], equals: loanId } } })).commissionStatus

suite.sequential("dpd-update isolation (real Postgres)", () => {
  beforeAll(async () => {
    a = await createChargesTenant(db, false)
    b = await createChargesTenant(db, false)
    ;[loanA, loanB] = await Promise.all([seedDefaultingLoan(a), seedDefaultingLoan(b)])
  })
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })

  it("tenant A's pass defaults and claws back A's 90-DPD loan and leaves tenant B's rows exactly as they were", async () => {
    const beforeB = await loanOf(loanB)

    await runWithTenant(a.tenantId, () => updateTenantDpd(a.tenantId))

    const afterA = await loanOf(loanA)
    expect(afterA.status).toBe("DEFAULTED")
    expect(afterA.daysInArrears).toBeGreaterThanOrEqual(90)
    expect(await commissionOf(loanA)).toBe("REVERSED")

    expect(await loanOf(loanB), "B's loan row is untouched, updatedAt included").toEqual(beforeB)
    expect(await commissionOf(loanB)).toBe("PENDING")
  })

  it("marks only the tenant it ran for as done today", async () => {
    expect(await cronDoneToday(`dpd-update:${a.tenantId}`)).toBe(true)
    expect(await cronDoneToday(`dpd-update:${b.tenantId}`)).toBe(false)
  })

  it("ensureDpdCurrent leaves a tenant that is already done alone, and runs the pass for one that is not", async () => {
    const afterFirst = await loanOf(loanA)
    await runWithTenant(a.tenantId, () => ensureDpdCurrent(a.tenantId))
    expect(await loanOf(loanA), "A was already done: no second pass").toEqual(afterFirst)

    await runWithTenant(b.tenantId, () => ensureDpdCurrent(b.tenantId))
    const afterB = await loanOf(loanB)
    expect(afterB.status).toBe("DEFAULTED")
    expect(await commissionOf(loanB)).toBe("REVERSED")
    expect(await cronDoneToday(`dpd-update:${b.tenantId}`)).toBe(true)
  })
})
