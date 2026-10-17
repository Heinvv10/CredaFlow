/**
 * Real-Postgres tests of what the locked payout re-check reads
 * (lib/affordability/current-approval.ts verifyLockedCurrentAffordabilityApproval,
 * whose wiring is unit-tested in current-approval.test.ts): Regulation 42's
 * repeat short-term rate counts the client's credit approved ahead of this
 * application, and a sibling booked a rounding cent off the instalment its
 * approval recorded does not block the payout.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/affordability/own-lender-payout.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { createApprovedPasqV3Application, type PasqV3Scenario } from "@/lib/compliance/pasq-v3-application.integration-fixture"
import { checkRepeatShortTermFor } from "@/lib/loan/nca-interest-cap.server"
import { ownLenderDebtIncreasedSinceApproval } from "./own-lender-debt-load"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const DAY = 86_400_000

suite.sequential("the payout re-check of an approval (real Postgres)", () => {
  let a: PasqV3Scenario
  let approvedAt = new Date()

  /** Another loan of A's client, its application approved `approvedOffsetMs` from A's approval. */
  async function siblingLoan(status: "COMPLETED" | "ACTIVE", approvedOffsetMs: number) {
    const n = randomUUID().replaceAll("-", "").slice(0, 10)
    const product = await db.loanProduct.create({
      data: {
        tenantId: a.tenantId, code: `S-${n}`, name: "Micro", productType: "MICRO", minAmount: 1, maxAmount: 1_000_000,
        minTermDays: 1, maxTermDays: 365, interestRatePm: 0.05, interestModel: "FLAT", monthlyServiceFee: 0,
      },
    })
    const app = await db.loanApplication.create({
      data: {
        tenantId: a.tenantId, reference: `APP-S-${n}`, clientId: a.clientId, productId: product.id,
        appliedAmount: 300_000, appliedTermDays: 90, approvedAt: new Date(approvedAt.getTime() + approvedOffsetMs),
      },
    })
    const open = status === "ACTIVE"
    return db.loan.create({
      data: {
        tenantId: a.tenantId, reference: `LN-S-${n}`, applicationId: app.id, clientId: a.clientId, productId: product.id,
        principal: 300_000, totalInterest: 15_000, initiationFee: 0, totalRepayable: 315_000,
        totalPaid: open ? 0 : 315_000, outstandingPrincipal: open ? 300_000 : 0,
        startDate: new Date(Date.now() - 5 * DAY), maturityDate: new Date(Date.now() + 85 * DAY),
        interestRatePm: 0.05, interestModel: "FLAT", status, ...(open ? {} : { closedAt: new Date() }),
        repaymentSchedule: {
          create: [1, 2, 3].map((i) => ({
            tenantId: a.tenantId, installmentNo: i, dueDate: new Date(Date.now() + i * 30 * DAY),
            principalDue: 100_000, interestDue: 5_000, feesDue: 0, totalDue: 105_000,
            totalPaid: open ? 0 : 105_000, status: open ? "PENDING" : "PAID",
          })),
        },
      },
    })
  }

  const verifyPayout = async () => {
    const application = await db.loanApplication.findUniqueOrThrow({ where: { id: a.applicationId }, include: { product: true } })
    return runWithTenant(a.tenantId, () => checkRepeatShortTermFor(prisma, a.tenantId, application, new Date()))
  }

  beforeAll(async () => {
    // A: R5,000 over 30 days at 5% a month (short-term), approved, not paid out.
    a = await createApprovedPasqV3Application("payout-recheck")
    approvedAt = (await db.loanApplication.findUniqueOrThrow({ where: { id: a.applicationId } })).approvedAt!
  }, 60_000)
  afterAll(async () => {
    await db.$disconnect()
  })

  it("passes while the client has no earlier short-term credit this year", async () => {
    expect(await verifyPayout()).toMatchObject({ ok: true })
  })

  it("ignores short-term credit approved after this application was", async () => {
    await siblingLoan("COMPLETED", 60_000)
    expect(await verifyPayout()).toMatchObject({ ok: true })
  })

  it("refuses the payout once short-term credit approved ahead of it has been paid out this year", async () => {
    await siblingLoan("COMPLETED", -60_000)
    expect(await verifyPayout()).toMatchObject({ ok: false, reason: "REPEAT_SHORT_TERM" })
  })

  it("treats a sibling booked a rounding cent off its recorded instalment as the same obligation", async () => {
    const loan = await siblingLoan("ACTIVE", 120_000)
    const source = (recordedCents: number) => {
      const entry = { sourceId: `own-loan:${loan.id}`, provider: "Acme Lending", type: "LOAN", balance: 300_000, monthlyInstalmentCents: recordedCents }
      return {
        existingDebtObligations: [], client: { id: a.clientId, debtObligations: [] },
        affordabilityResult: { schemaVersion: 3, approval: { debts: { application: [entry], client: [entry] } } },
      }
    }
    const raised = (recordedCents: number) => runWithTenant(a.tenantId, () =>
      ownLenderDebtIncreasedSinceApproval(prisma, a.tenantId, a.applicationId, source(recordedCents)))
    expect(await raised(105_000 - 1)).toBe(false)
    expect(await raised(105_000 - 101)).toBe(true)
  })
})
