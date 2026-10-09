/**
 * Real-Postgres proof of what makes a past month-end figure unsafe to report.
 *
 * Default charges posted AFTER the period do not, nor does a Section 129
 * notice issued after it: the charge replay stops at the as-at date, so the
 * month-end balance is the same before and after. A receipt after the period
 * does, and is still held. So does switching default charges on or off for
 * the tenant after the period, which holds the whole book.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run --no-file-parallelism lib/bureau-submission/post-period.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"

vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

import { prisma } from "@/lib/prisma"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { sweepTenantCharges } from "@/lib/loan/charges-sweep"
import { INSTALMENT, createBureauLoan, sast, syntheticSaId } from "./bureau.integration-fixture"
import { generateMonthly } from "./generate"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

/** R2,000 bullet due 1 Sep at 5% a month with a R69 monthly fee; default charges live. */
async function overdueLoan() {
  const tenant = await createChargesTenant(db, true)
  await db.tenantConfig.update({
    where: { tenantId: tenant.tenantId },
    data: {
      featureBureauSubmission: true, bureauSupplierNumber: "TT0109", bureauTradingName: "Charges IT",
      bureauReportingStartDate: new Date("2026-06-01T00:00:00.000Z"),
    },
  })
  const loan = await createChargesLoan(db, tenant)
  await db.client.update({ where: { id: loan.clientId }, data: { idNumber: syntheticSaId() } })
  return loan
}

const FIGURES = ["currentBalance", "amountOverdue", "instalment", "monthsInArrears", "lastPaymentDate", "statusCode"] as const

/** September's file as generated at `now`: the loan's line, sent or held, with its figures as numbers. */
async function september(loan: { tenantId: string; loanId: string }, now: Date) {
  vi.setSystemTime(now)
  const result = await runWithTenant(loan.tenantId, () => generateMonthly(prisma, {
    tenantId: loan.tenantId, periodDay: "2026-09-30", mode: "TEST", now, actor: { source: "staff" },
  }))
  if (result.outcome !== "GENERATED") throw new Error(`expected GENERATED, got ${result.outcome}`)
  const row = await db.bureauSubmissionRecord.findFirstOrThrow({ where: { submissionId: result.submissionId, loanId: loan.loanId } })
  const fields = row.fields as Record<string, string>
  return {
    held: row.heldReason,
    figures: Object.fromEntries(FIGURES.map((name) => [name, /^\d+$/.test(fields[name] ?? "") ? Number(fields[name]) : fields[name] ?? ""])),
  }
}

const sweep = (tenantId: string, asOf: Date) => {
  vi.setSystemTime(asOf)
  return runWithTenant(tenantId, () => sweepTenantCharges(prisma, tenantId, asOf, { source: "it:post-period" }))
}

suite.sequential("activity after the period (real Postgres, default charges live)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: sast("2026-09-20") }) })
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })

  it("charges posted after the period leave the month-end figures unchanged, and the loan is still sent", async () => {
    const loan = await overdueLoan()
    // A part payment inside the period, so the receipt-to-charges split is in play.
    vi.setSystemTime(sast("2026-09-20"))
    await runWithTenant(loan.tenantId, () => applyManualReceipt(prisma, {
      loanId: loan.loanId, tenantId: loan.tenantId, amount: 50_000, receivedAt: sast("2026-09-20"), capturedById: loan.userId,
    }))
    await sweep(loan.tenantId, sast("2026-09-30", "23:00:00"))

    const before = await september(loan, sast("2026-10-01", "00:30:00"))
    expect(before.held).toBeNull()
    expect(before.figures.currentBalance).toBeGreaterThan(0)
    expect(before.figures.amountOverdue).toBeGreaterThan(0)

    // The nightly job runs for five more days: default interest to 5 Oct and the fee of 1 Oct.
    for (const day of ["2026-10-01", "2026-10-02", "2026-10-05"]) await sweep(loan.tenantId, sast(day, "01:30:00"))
    const posted = await db.loanCharge.count({ where: { loanId: loan.loanId, day: { gt: new Date("2026-09-30T00:00:00.000Z") } } })
    expect(posted).toBeGreaterThan(0)

    const after = await september(loan, sast("2026-10-05", "09:00:00"))
    expect(after.figures).toEqual(before.figures)
    expect(after.held).toBeNull()
  })

  it("figures are unchanged for a two-instalment loan with a late in-period receipt, and by a Section 129 notice issued after the period", async () => {
    const tenant = await createChargesTenant(db, true)
    await db.tenantConfig.update({
      where: { tenantId: tenant.tenantId },
      data: { featureBureauSubmission: true, bureauSupplierNumber: "TT0109", bureauTradingName: "Charges IT", bureauReportingStartDate: new Date("2026-06-01T00:00:00.000Z") },
    })
    const products = { PERSONAL: tenant.productId, MICRO: tenant.productId, PO_FUNDING: tenant.productId }
    // Instalments due 1 Aug and 1 Sep; default interest at 5% a month.
    const created = await createBureauLoan(db, { tenantId: tenant.tenantId, userId: tenant.userId, products }, { productType: "MICRO" })
    await db.loan.update({ where: { id: created.loanId }, data: { interestRatePm: 0.05 } })
    const loan = { tenantId: tenant.tenantId, loanId: created.loanId }
    // The first instalment is paid 19 days late, so the receipt is split between charges and the schedule.
    vi.setSystemTime(sast("2026-08-20"))
    await runWithTenant(tenant.tenantId, () => applyManualReceipt(prisma, {
      loanId: created.loanId, tenantId: tenant.tenantId, amount: INSTALMENT, receivedAt: sast("2026-08-20"), capturedById: tenant.userId,
    }))
    await sweep(tenant.tenantId, sast("2026-09-30", "23:00:00"))
    const before = await september(loan, sast("2026-10-01", "00:30:00"))
    expect(before.held).toBeNull()
    expect(before.figures.amountOverdue).toBeGreaterThan(0)

    // 3 Oct: a Section 129 notice is issued and its admin charge is frozen onto it.
    await db.complianceRecord.create({
      data: {
        tenantId: tenant.tenantId, type: "SECTION_129_NOTICE", referenceId: created.loanId, status: "COMPLETED",
        completedAt: sast("2026-10-03"), data: { lifecycle: "ISSUED", adminChargeCents: 8_200, adminChargeAt: sast("2026-10-03").toISOString() },
      },
    })
    for (const day of ["2026-10-01", "2026-10-03", "2026-10-06"]) await sweep(tenant.tenantId, sast(day, "01:30:00"))
    const letter = await db.loanCharge.count({ where: { loanId: created.loanId, type: "DEFAULT_ADMIN" } })
    expect(letter).toBe(1)

    const after = await september(loan, sast("2026-10-06", "09:00:00"))
    expect(after.figures).toEqual(before.figures)
    expect(after.held).toBeNull()
  })

  it("holds the book when default charges went live after the period: go-live back-charges into it", async () => {
    const loan = await overdueLoan()
    await db.tenantConfig.update({ where: { tenantId: loan.tenantId }, data: { defaultChargesStartedAt: sast("2026-10-02") } })
    expect((await september(loan, sast("2026-10-05", "09:00:00"))).held).toBe("CHARGES_SWITCHED_AFTER_PERIOD")
    // A period that ends after go-live is not held for it.
    await db.tenantConfig.update({ where: { tenantId: loan.tenantId }, data: { defaultChargesStartedAt: sast("2026-09-30", "12:00:00") } })
    expect((await september(loan, sast("2026-10-05", "10:00:00"))).held).toBeNull()
  })

  it("holds the book when default charges were stopped after the period: a stop wipes every charge", async () => {
    const loan = await overdueLoan()
    const before = await september(loan, sast("2026-10-01", "00:30:00"))
    expect(before.held).toBeNull()
    await db.tenantConfig.update({ where: { tenantId: loan.tenantId }, data: { defaultChargesEnabled: false, defaultChargesStoppedAt: sast("2026-10-03") } })
    const after = await september(loan, sast("2026-10-05", "09:00:00"))
    expect(after.held).toBe("CHARGES_SWITCHED_AFTER_PERIOD")
    // What the hold prevents: without charges the same month end reads lower.
    expect(after.figures.amountOverdue).toBeLessThan(before.figures.amountOverdue as number)
  })

  it("a receipt dated after the period is still held", async () => {
    const loan = await overdueLoan()
    vi.setSystemTime(sast("2026-10-03"))
    await runWithTenant(loan.tenantId, () => applyManualReceipt(prisma, {
      loanId: loan.loanId, tenantId: loan.tenantId, amount: 50_000, receivedAt: sast("2026-10-03"), capturedById: loan.userId,
    }))
    expect((await september(loan, sast("2026-10-05", "09:00:00"))).held).toBe("POST_PERIOD_ACTIVITY")
  })
})
