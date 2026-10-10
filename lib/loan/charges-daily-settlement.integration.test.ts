/**
 * Round-3 probe kept as a regression: a daily-accrual bullet settled on day 15
 * at the s125 figure, one cent under or over, through manual capture and bank
 * sync, always ends COMPLETED at the repriced total.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/charges-daily-settlement.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesLoan, createChargesTenant, DAILY_SETTLEMENT_NOW, NOW } from "./charges.integration-fixture"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn(async () => ({ error: null, user: { id: ctx.userId, email: "d@test.invalid", role: "SUPER_ADMIN" } })) }))
vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))
import { prisma as payments } from "@/lib/prisma"
import { applyManualReceipt } from "./apply-payment"
import { applyBankTransaction } from "@/lib/bank-sync/apply"
import { waiveSmallBalance } from "./small-balance-waiver"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
async function createLoan() {
  const ids = await createChargesLoan(db, await createChargesTenant(db, true), { dailyAccrual: true })
  ctx.tenantId = ids.tenantId; ctx.userId = ids.userId
  return ids
}
type Ids = Awaited<ReturnType<typeof createLoan>>
const writers: Record<string, (ids: Ids, amount: number) => Promise<unknown>> = {
  manual: (ids, amount) => runWithTenant(ids.tenantId, () => applyManualReceipt(payments, { loanId: ids.loanId, tenantId: ids.tenantId, amount, capturedById: ids.userId })),
  bank: async (ids, amount) => {
    const imp = await db.bankStatementImport.create({ data: { tenantId: ids.tenantId, source: "ABSA_ONLINE", accountRef: "****1234", format: "CSV", fileHash: randomUUID(), rawFilePath: "x" } })
    const txn = await db.bankTransaction.create({ data: { tenantId: ids.tenantId, importId: imp.id, postedDate: NOW, valueDate: NOW, amountCents: amount, direction: "CREDIT", dedupHash: randomUUID(), matchStatus: "PROPOSED" } })
    return applyBankTransaction({ txnId: txn.id, loanId: ids.loanId, tenantId: ids.tenantId, userEmail: "x@test.invalid" })
  },
}
suite.sequential("daily-accrual ±1c settlement", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => { vi.useRealTimers(); await db.$disconnect() })
  beforeEach(() => { vi.setSystemTime(NOW) })
  for (const [name, book] of Object.entries(writers)) {
    for (const delta of [-1, 0, 1]) {
      it(`${name} settlement${delta >= 0 ? "+" : ""}${delta}`, async () => {
        const ids = await createLoan()
        await book(ids, DAILY_SETTLEMENT_NOW + delta)
        let loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, include: { repaymentSchedule: true } })
        // One cent short leaves a 1c residue, which the small-balance waiver closes.
        if (loan.status === "ACTIVE") {
          await runWithTenant(ids.tenantId, () => waiveSmallBalance(payments, { tenantId: ids.tenantId, loanId: ids.loanId, reason: "residue", userId: ids.userId, userEmail: null }))
          loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, include: { repaymentSchedule: true } })
        }
        expect(loan.status).toBe("COMPLETED")
        expect(loan.totalRepayable).toBe(DAILY_SETTLEMENT_NOW)
      })
    }
  }
})
