/**
 * Real-Postgres test: a DAILY_ACCRUAL bullet (MICRO30's shape) through every
 * receipt writer while default charges are live. A partial receipt before
 * maturity must stay a partial — no s125 early-settlement reprice — and a
 * full one must still get the lawful reprice (review round 2, N1).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/charges-daily-accrual.integration.test.ts
 */
import { createHmac, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesLoan, createChargesTenant, DAILY_SETTLEMENT_NOW, NOW, SCHEDULE_TOTAL } from "./charges.integration-fixture"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({
    error: null, user: { id: ctx.userId, email: "daily-it@test.invalid", role: "SUPER_ADMIN" },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
    await runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
  getDefaultTenantId: async () => ctx.tenantId,
}))
vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

import { prisma as payments } from "@/lib/prisma"
import { applyManualReceipt } from "./apply-payment"
import { applyBankTransaction } from "@/lib/bank-sync/apply"
import { PATCH as reconcile } from "@/app/api/payments/[id]/reconcile/route"
import { POST as bulkUpload } from "@/app/api/payments/bulk-upload/route"
import { POST as stitchWebhook } from "@/app/api/portal/payment/webhook/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

async function createLoan() {
  const ids = await createChargesLoan(db, await createChargesTenant(db, true), { dailyAccrual: true })
  ctx.tenantId = ids.tenantId
  ctx.userId = ids.userId
  return ids
}
type Ids = Awaited<ReturnType<typeof createLoan>>

/** Book `amount` on the loan through one writer family. */
const writers: Record<string, (ids: Ids, amount: number) => Promise<unknown>> = {
  manual: (ids, amount) => runWithTenant(ids.tenantId, () => applyManualReceipt(payments, {
    loanId: ids.loanId, tenantId: ids.tenantId, amount, capturedById: ids.userId,
  })),
  bank: async (ids, amount) => {
    const imp = await db.bankStatementImport.create({
      data: { tenantId: ids.tenantId, source: "ABSA_ONLINE", accountRef: "****1234", format: "CSV", fileHash: randomUUID(), rawFilePath: "x" },
    })
    const txn = await db.bankTransaction.create({
      data: {
        tenantId: ids.tenantId, importId: imp.id, postedDate: NOW, valueDate: NOW,
        amountCents: amount, direction: "CREDIT", dedupHash: randomUUID(), matchStatus: "PROPOSED",
      },
    })
    return applyBankTransaction({ txnId: txn.id, loanId: ids.loanId, tenantId: ids.tenantId, userId: ids.userId, userEmail: "x@test.invalid" })
  },
  reconcile: async (ids, amount) => {
    const held = await db.payment.create({
      data: { tenantId: ids.tenantId, loanId: ids.loanId, amount, receivedAt: NOW, allocationStatus: "UNAPPLIED", reconciliationReason: "held" },
    })
    return reconcile(new NextRequest("http://localhost/api/test", {
      method: "PATCH", body: JSON.stringify({ action: "allocate", reason: "Matched to loan", reference: "BANK-9" }),
    }), { params: Promise.resolve({ id: held.id }) })
  },
  bulk: async (ids, amount) => {
    const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId } })
    return bulkUpload(new NextRequest("http://localhost/api/test", {
      method: "POST", body: JSON.stringify({ rows: [{ reference: loan.reference, amount: amount / 100 }] }),
    }))
  },
  stitch: async (ids, amount) => {
    process.env.STITCH_WEBHOOK_SECRET = "daily-it-secret"
    const stitchId = `stitch_daily_${randomUUID()}`
    await db.stitchPaymentRequest.create({
      data: {
        stitchId, loanId: ids.loanId, clientId: ids.clientId, amount,
        redirectUrl: "https://x.invalid", stitchUrl: "https://x.invalid", externalReference: stitchId,
      },
    })
    const body = JSON.stringify({ type: "payment.completed", data: { id: stitchId } })
    const signature = createHmac("sha256", "daily-it-secret").update(body).digest("hex")
    return runWithTenant(ids.tenantId, () => stitchWebhook(new Request("http://localhost/webhook", {
      method: "POST", body, headers: { "x-stitch-signature": signature },
    })))
  },
}

suite.sequential("daily-accrual receipts with default charges live (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })
  beforeEach(() => { vi.setSystemTime(NOW) })

  for (const [name, book] of Object.entries(writers)) {
    it(`${name}: R500 on day 15 is a partial payment, with no early-settlement reprice`, async () => {
      const ids = await createLoan()
      await book(ids, 50_000)
      const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, include: { repaymentSchedule: true } })
      expect(loan).toMatchObject({
        status: "ACTIVE", closedAt: null, totalPaid: 50_000, totalInterest: 10_000, totalRepayable: SCHEDULE_TOTAL,
      })
      expect(loan.repaymentSchedule[0]).toMatchObject({ interestDue: 10_000, totalDue: SCHEDULE_TOTAL, totalPaid: 50_000 })
      expect(await db.auditLog.count({ where: { entityId: ids.loanId, action: "LOAN_STATUS_CHANGED" } })).toBe(0)
    })
  }

  it("a full settlement on day 15 still gets the lawful s125 reprice", async () => {
    const ids = await createLoan()
    await writers.manual(ids, DAILY_SETTLEMENT_NOW)
    const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, include: { repaymentSchedule: true } })
    expect(loan).toMatchObject({
      status: "COMPLETED", totalPaid: DAILY_SETTLEMENT_NOW, totalInterest: 5_000, totalRepayable: DAILY_SETTLEMENT_NOW,
    })
    expect(loan.repaymentSchedule[0]).toMatchObject({ interestDue: 5_000, totalDue: DAILY_SETTLEMENT_NOW })
  })
})
