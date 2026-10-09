/**
 * Real-Postgres test of the default-charges back-fill and the nightly sweep.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/charges-backfill.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { applyChargesBackfill, planChargesBackfill } from "./charges-backfill"
import { sweepTenantCharges } from "./charges-sweep"
import {
  createChargesLoan,
  createChargesTenant,
  DEFAULT_INTEREST,
  NOW,
  SCHEDULE_TOTAL,
} from "./charges.integration-fixture"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

async function snapshot(tenantId: string) {
  const [loans, charges, payments, audits] = await Promise.all([
    db.loan.findMany({ where: { tenantId }, include: { repaymentSchedule: true }, orderBy: { id: "asc" } }),
    db.loanCharge.count({ where: { tenantId } }),
    db.payment.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
    db.auditLog.count({ where: { tenantId } }),
  ])
  return { loans, charges, payments, audits }
}

suite.sequential("default-charges back-fill and sweep (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })

  it("dry run reports what the replay would post and writes nothing, with the flag still off", async () => {
    const tenant = await createChargesTenant(db, false)
    const loan = await createChargesLoan(db, tenant)
    await db.payment.create({
      data: { tenantId: tenant.tenantId, loanId: loan.loanId, amount: 50_000, receivedAt: NOW },
    })
    await db.loan.update({ where: { id: loan.loanId }, data: { totalPaid: 50_000 } })
    await db.repaymentSchedule.updateMany({ where: { loanId: loan.loanId }, data: { totalPaid: 50_000, status: "PARTIAL" } })
    const before = await snapshot(tenant.tenantId)

    const plan = await runWithTenant(tenant.tenantId, () => planChargesBackfill(prisma, tenant.tenantId, NOW))

    expect(plan.rows).toEqual([expect.objectContaining({
      loan: loan.loanId.slice(0, 12),
      product: "MICRO",
      daysOverdue: 25,
      defaultInterest: DEFAULT_INTEREST,
      serviceFees: 0,
      letterCharges: 0,
      totalPaidBefore: 50_000,
      totalPaidAfter: 50_000 - DEFAULT_INTEREST,
      overduePrincipal: 200_000 - (50_000 - DEFAULT_INTEREST - 16_900),
      inDuplum: { capBase: 200_000, accrued: DEFAULT_INTEREST, reached: false },
    })])
    expect(plan.total).toMatchObject({ loans: 1, defaultInterest: DEFAULT_INTEREST, charges: DEFAULT_INTEREST })
    expect(await snapshot(tenant.tenantId)).toEqual(before)
  })

  it("--apply switches the flag on and records go-live in one audited change, then posts", async () => {
    const tenant = await createChargesTenant(db, false)
    const loan = await createChargesLoan(db, tenant)
    const actor = { userId: tenant.userId, userEmail: "a@test.invalid" }

    await runWithTenant(tenant.tenantId, () => applyChargesBackfill(prisma, tenant.tenantId, NOW, actor))

    expect(await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: tenant.tenantId } }))
      .toMatchObject({ defaultChargesEnabled: true, defaultChargesStartedAt: NOW })
    const started = await db.auditLog.findMany({ where: { tenantId: tenant.tenantId, entity: "TenantConfig" } })
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      action: "DEFAULT_CHARGES_STARTED", userId: tenant.userId,
      oldValue: { defaultChargesEnabled: false, defaultChargesStartedAt: null },
      newValue: { defaultChargesEnabled: true, defaultChargesStartedAt: NOW.toISOString() },
    })
    // Go-live is now: the loan overdue since 1 Sep is back-charged from 2 Sep.
    expect(await db.loan.findUniqueOrThrow({ where: { id: loan.loanId } })).toMatchObject({ chargesAccrued: DEFAULT_INTEREST })
  })

  it("--apply refuses, writing nothing, while any loan's ledger fails the identity; the dry run lists it", async () => {
    const tenant = await createChargesTenant(db, false)
    const fine = await createChargesLoan(db, tenant)
    const broken = await createChargesLoan(db, tenant)
    // A receipt the loan row never took in: SUM(receipts) != Loan.totalPaid.
    await db.payment.create({ data: { tenantId: tenant.tenantId, loanId: broken.loanId, amount: 10_000, receivedAt: NOW } })
    const before = await snapshot(tenant.tenantId)

    const plan = await runWithTenant(tenant.tenantId, () => planChargesBackfill(prisma, tenant.tenantId, NOW))
    expect(plan.mismatches).toEqual([{ loanId: broken.loanId, scheduleTotalPaid: 0, loanTotalPaid: 0, receiptsScheduleShare: 10_000 }])
    expect(plan.mismatches.map((m) => m.loanId)).not.toContain(fine.loanId)

    await expect(runWithTenant(tenant.tenantId, () =>
      applyChargesBackfill(prisma, tenant.tenantId, NOW, { userId: tenant.userId, userEmail: "a@test.invalid" }),
    )).rejects.toThrow(broken.loanId)
    expect(await snapshot(tenant.tenantId)).toEqual(before)
    expect((await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: tenant.tenantId } })).defaultChargesEnabled).toBe(false)
  })

  it("--apply posts through the sync with an attributed audit row per loan, and is idempotent", async () => {
    const tenant = await createChargesTenant(db, true)
    const loan = await createChargesLoan(db, tenant)
    const actor = { userId: tenant.userId, userEmail: "backfill@test.invalid" }

    const first = await runWithTenant(tenant.tenantId, () => applyChargesBackfill(prisma, tenant.tenantId, NOW, actor))
    expect(first).toMatchObject({ loans: 1, changed: 1, failures: [] })
    const audits = await db.auditLog.findMany({ where: { entityId: loan.loanId, action: "LOAN_CHARGES_SYNCED" } })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ userId: tenant.userId, userEmail: "backfill@test.invalid" })
    expect(audits[0].newValue).toMatchObject({ source: "backfill", chargesAccrued: DEFAULT_INTEREST })

    const after = await snapshot(tenant.tenantId)
    const second = await runWithTenant(tenant.tenantId, () => applyChargesBackfill(prisma, tenant.tenantId, NOW, actor))
    expect(second).toMatchObject({ loans: 1, changed: 0, failures: [] })
    expect(await snapshot(tenant.tenantId)).toEqual(after)
  })

  it("the first --apply records go-live (audited) and never back-charges a loan paid up before it", async () => {
    const tenant = await createChargesTenant(db, true)
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { defaultChargesStartedAt: null } })
    const late = await createChargesLoan(db, tenant)
    const owing = await createChargesLoan(db, tenant)
    // Paid in full nine days late, before go-live: stays exactly as it was.
    await db.payment.create({ data: { tenantId: tenant.tenantId, loanId: late.loanId, amount: SCHEDULE_TOTAL, receivedAt: new Date("2026-09-10T10:00:00+02:00") } })
    await db.loan.update({ where: { id: late.loanId }, data: { totalPaid: SCHEDULE_TOTAL, status: "ACTIVE" } })
    await db.repaymentSchedule.updateMany({ where: { loanId: late.loanId }, data: { totalPaid: SCHEDULE_TOTAL, status: "PAID" } })
    const actor = { userId: tenant.userId, userEmail: "backfill@test.invalid" }

    await runWithTenant(tenant.tenantId, () => applyChargesBackfill(prisma, tenant.tenantId, NOW, actor))

    const config = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: tenant.tenantId } })
    expect(config.defaultChargesStartedAt).toEqual(NOW)
    const started = await db.auditLog.findMany({ where: { tenantId: tenant.tenantId, action: "DEFAULT_CHARGES_STARTED" } })
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ userId: tenant.userId, entity: "TenantConfig" })
    expect(await db.loan.findUniqueOrThrow({ where: { id: late.loanId } }))
      .toMatchObject({ chargesAccrued: 0, totalPaid: SCHEDULE_TOTAL })
    expect(await db.loan.findUniqueOrThrow({ where: { id: owing.loanId } }))
      .toMatchObject({ chargesAccrued: DEFAULT_INTEREST })

    // A later run keeps the original go-live.
    vi.setSystemTime(new Date("2026-09-28T10:00:00+02:00"))
    await runWithTenant(tenant.tenantId, () => applyChargesBackfill(prisma, tenant.tenantId, new Date(), actor))
    vi.setSystemTime(NOW)
    expect((await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: tenant.tenantId } })).defaultChargesStartedAt).toEqual(NOW)
    expect(await db.auditLog.count({ where: { tenantId: tenant.tenantId, action: "DEFAULT_CHARGES_STARTED" } })).toBe(1)
  })

  it("--apply refuses before switching anything on while any loan would fail the sweep", async () => {
    const tenant = await createChargesTenant(db, false)
    const broken = await createChargesLoan(db, tenant)
    // More live money than everything owed: the replay refuses this loan.
    await db.payment.create({
      data: { tenantId: tenant.tenantId, loanId: broken.loanId, amount: SCHEDULE_TOTAL + DEFAULT_INTEREST + 1, receivedAt: NOW },
    })
    await db.loan.update({ where: { id: broken.loanId }, data: { totalPaid: SCHEDULE_TOTAL + DEFAULT_INTEREST + 1 } })
    await db.repaymentSchedule.updateMany({ where: { loanId: broken.loanId }, data: { totalPaid: SCHEDULE_TOTAL + DEFAULT_INTEREST + 1 } })
    const before = await snapshot(tenant.tenantId)
    const plan = await runWithTenant(tenant.tenantId, () => planChargesBackfill(prisma, tenant.tenantId, NOW))
    expect(plan.wouldFail).toEqual([{ loanId: broken.loanId, error: expect.stringMatching(/unallocated/) }])
    await expect(runWithTenant(tenant.tenantId, () =>
      applyChargesBackfill(prisma, tenant.tenantId, NOW, { userId: tenant.userId, userEmail: "a@test.invalid" }),
    )).rejects.toThrow(/would fail the sweep/)
    expect(await snapshot(tenant.tenantId)).toEqual(before)
    expect(await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: tenant.tenantId } }))
      .toMatchObject({ defaultChargesEnabled: false, defaultChargesStartedAt: null })
  })

  it("sweep isolates a loan whose sync fails and still syncs the rest", async () => {
    const tenant = await createChargesTenant(db, true)
    const good = await createChargesLoan(db, tenant)
    const broken = await createChargesLoan(db, tenant)
    // More live money than everything owed: the replay refuses this loan.
    await db.payment.create({
      data: { tenantId: tenant.tenantId, loanId: broken.loanId, amount: SCHEDULE_TOTAL + DEFAULT_INTEREST + 1, receivedAt: NOW },
    })

    const result = await runWithTenant(tenant.tenantId, () =>
      sweepTenantCharges(prisma, tenant.tenantId, NOW, { source: "cron:default-charges" }))

    expect(result.loans).toBe(2)
    expect(result.failures).toEqual([{ loanId: broken.loanId, error: expect.stringMatching(/unallocated/) }])
    const synced = await db.loan.findUniqueOrThrow({ where: { id: good.loanId } })
    expect(synced.chargesAccrued).toBe(DEFAULT_INTEREST)
  })
})
