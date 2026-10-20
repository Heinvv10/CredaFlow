/**
 * Real-Postgres proof for the escalation cron (lib/collections/escalation.ts):
 * the 60-DPD DEFAULTED flip is business logic and happens for every loan, but
 * the borrower's loan_overdue notice goes only to a loan that is not held
 * (lib/collections/dunning-holds.ts), and the skip is reported.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/collections/escalation-holds.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import {
  createSecondProduct, HOLD_CASES, seedHoldLoan, type SeededHoldLoan,
} from "@/lib/collections/dunning-holds.integration-fixture"

const notified = vi.hoisted(() => [] as string[])
vi.mock("@/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications")>()),
  triggerNotification: vi.fn(async (a: { loanId: string }) => { notified.push(a.loanId) }),
}))

import { prisma } from "@/lib/prisma"
import { processEscalations } from "@/lib/collections/escalation"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

let tenant: ChargesTenant
const seeded: SeededHoldLoan[] = []
let details: string[] = []

// The escalation query takes ACTIVE and DEFAULTED loans only.
const ESCALATABLE = HOLD_CASES.filter((c) => c.status === undefined)

suite.sequential("escalation borrower notice and dunning holds (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    const second = await createSecondProduct(db, tenant.tenantId)
    for (const c of ESCALATABLE) seeded.push(await seedHoldLoan(db, tenant, second, c, { inArrears: true }))
    details = (await processEscalations()).details
  })
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })

  it("flips every loan to DEFAULTED, held or not: the status change is business logic", async () => {
    const rows = await db.loan.findMany({ where: { id: { in: seeded.map((s) => s.loanId) } }, select: { id: true, status: true } })
    expect(rows).toHaveLength(seeded.length)
    for (const row of rows) expect(row.status, row.id).toBe("DEFAULTED")
  })

  it("notifies the borrower of a loan that is not held, and of no held one", () => {
    expect(notified.length, "the harness must observe the notification").toBeGreaterThan(0)
    for (const s of seeded) expect(notified.includes(s.loanId), `${s.name}: ${s.held ? "must be held" : "must be notified"}`).toBe(!s.held)
  })

  it("reports each skipped notification", () => {
    const skipped = details.filter((d) => d.includes("borrower notification skipped (dunning hold)"))
    expect(skipped).toHaveLength(seeded.filter((s) => s.held).length)
  })
})
