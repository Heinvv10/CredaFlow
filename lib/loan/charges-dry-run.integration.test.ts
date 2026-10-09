/**
 * Real-Postgres test: the back-fill dry run previews exactly what the
 * following --apply writes, per loan, at first go-live (review round 2, N6).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/charges-dry-run.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { applyChargesBackfill, planChargesBackfill, type BackfillPlan } from "./charges-backfill"
import { createChargesLoan, createChargesTenant, NOW, type ChargesTenant } from "./charges.integration-fixture"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

/** Every loan the plan previewed now holds exactly the planned figures. */
async function expectAppliedAsPlanned(plan: BackfillPlan, tenantId: string) {
  const loans = await db.loan.findMany({ where: { tenantId }, include: { charges: true } })
  expect(plan.rows.length).toBeGreaterThan(0)
  for (const row of plan.rows) {
    const loan = loans.find((l) => l.id.startsWith(row.loan))!
    const sum = (type: string) => loan.charges.filter((c) => c.type === type).reduce((s, c) => s + c.amount, 0)
    expect({
      loan: row.loan, defaultInterest: sum("DEFAULT_INTEREST"), serviceFees: sum("SERVICE_FEE"),
      letterCharges: sum("DEFAULT_ADMIN"), chargesOutstanding: loan.chargesOutstanding, totalPaidAfter: loan.totalPaid,
    }).toEqual({
      loan: row.loan, defaultInterest: row.defaultInterest, serviceFees: row.serviceFees,
      letterCharges: row.letterCharges, chargesOutstanding: row.chargesOutstanding, totalPaidAfter: row.totalPaidAfter,
    })
  }
}

const issueUnfrozenNotice = (tenant: ChargesTenant, loanId: string, day: string) =>
  db.complianceRecord.create({
    data: {
      tenantId: tenant.tenantId, type: "SECTION_129_NOTICE", referenceId: loanId, idempotencyKey: `s129-${loanId}`,
      status: "COMPLETED", completedAt: new Date(`${day}T10:00:00+02:00`), data: { lifecycle: "ISSUED" },
    },
  })

suite.sequential("default-charges dry run equals --apply (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })

  it("first go-live: the dry run's per-loan figures are what --apply writes", async () => {
    const tenant = await createChargesTenant(db, false)
    const overdue = await createChargesLoan(db, tenant)
    const part = await createChargesLoan(db, tenant)
    await issueUnfrozenNotice(tenant, overdue.loanId, "2026-09-10")
    await db.payment.create({ data: { tenantId: tenant.tenantId, loanId: part.loanId, amount: 50_000, receivedAt: new Date("2026-09-11T10:00:00+02:00") } })
    await db.loan.update({ where: { id: part.loanId }, data: { totalPaid: 50_000 } })
    await db.repaymentSchedule.updateMany({ where: { loanId: part.loanId }, data: { totalPaid: 50_000, status: "PARTIAL" } })
    const actor = { userId: tenant.userId, userEmail: "a@test.invalid" }

    const plan = await runWithTenant(tenant.tenantId, () => planChargesBackfill(prisma, tenant.tenantId, NOW))
    expect(plan.rows.find((r) => overdue.loanId.startsWith(r.loan))?.letterCharges).toBe(8_200)
    // The R500 was booked to the schedule before go-live; charging the default
    // open then moves part of it onto default interest: staff must accept that.
    expect(plan.needsAcceptance.map((n) => [n.loanId, n.changes])).toEqual([[part.loanId, ["lowers_total_paid"]]])
    await runWithTenant(tenant.tenantId, () => applyChargesBackfill(prisma, tenant.tenantId, NOW, actor, { accept: [part.loanId] }))
    await expectAppliedAsPlanned(plan, tenant.tenantId)
  })
})
