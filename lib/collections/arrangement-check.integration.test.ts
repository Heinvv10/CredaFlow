/**
 * Real-Postgres proof that the arrangement check settles EVERY ACTIVE tenant's
 * arrangements, not only the deployment's default: a broken arrangement of a
 * second lender must stop holding its loan out of reminders.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/collections/arrangement-check.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runArrangementCheck } from "@/lib/collections/arrangement-check"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const DAY = 86_400_000

let a: ChargesTenant
let b: ChargesTenant
let loanA: string
let loanB: string

/** A weekly arrangement that ran from 60 to 30 days ago with no payment received: BROKEN. */
async function seedBrokenArrangement(tenant: ChargesTenant): Promise<string> {
  const { loanId } = await createChargesLoan(db, tenant)
  await db.paymentArrangement.create({
    data: {
      tenantId: tenant.tenantId, loanId, arrangementDate: new Date(Date.now() - 61 * DAY), agreedAmount: 50_000,
      frequency: "WEEKLY", startDate: new Date(Date.now() - 60 * DAY), endDate: new Date(Date.now() - 30 * DAY), status: "ACTIVE",
    },
  })
  return loanId
}
const statusOf = async (loanId: string) => (await db.paymentArrangement.findFirstOrThrow({ where: { loanId } })).status

suite.sequential("arrangement-check sweeps every tenant (real Postgres)", () => {
  beforeAll(async () => {
    a = await createChargesTenant(db, false)
    b = await createChargesTenant(db, false)
    ;[loanA, loanB] = await Promise.all([seedBrokenArrangement(a), seedBrokenArrangement(b)])
  })
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })

  it("settles both tenants' arrangements to BROKEN and notes each loan under its own tenant", async () => {
    const result = await runArrangementCheck()

    expect(result.broken).toBeGreaterThanOrEqual(2)
    expect(await statusOf(loanA)).toBe("BROKEN")
    expect(await statusOf(loanB)).toBe("BROKEN")
    for (const [loanId, tenant] of [[loanA, a], [loanB, b]] as const) {
      const note = await db.loanNote.findFirstOrThrow({ where: { loanId, type: "arrangement_broken" } })
      expect(note.tenantId).toBe(tenant.tenantId)
    }
  })

  it("a second pass the same day has nothing left to settle for them", async () => {
    await runArrangementCheck()
    expect(await db.loanNote.count({ where: { loanId: { in: [loanA, loanB] }, type: "arrangement_broken" } })).toBe(2)
  })
})
