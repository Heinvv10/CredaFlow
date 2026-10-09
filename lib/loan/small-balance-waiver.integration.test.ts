/**
 * Real-Postgres test of the small-balance waiver: the loan must close through
 * the same projection and guards as a receipt, and the waived cents must not
 * reach any cash-collected figure.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/small-balance-waiver.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import {
  createChargesLoan,
  createChargesTenant,
  DEFAULT_INTEREST,
  NOW,
  SCHEDULE_TOTAL,
} from "./charges.integration-fixture"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({
    error: null,
    user: { id: ctx.userId, email: "waiver-it@test.invalid", role: "SUPER_ADMIN" },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
    await runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
}))

import { prisma } from "@/lib/prisma"
import { applyManualReceipt } from "./apply-payment"
import { getNcrReturnData } from "@/lib/compliance/ncr-return"
import { POST as waive } from "@/app/api/loans/[id]/small-balance-waiver/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const REASON = "Client paid R5,968.00 of R5,968.75; 75c is rounding."

async function loanWithResidue(enabled: boolean, paid: number) {
  const ids = await createChargesLoan(db, await createChargesTenant(db, enabled))
  ctx.tenantId = ids.tenantId
  ctx.userId = ids.userId
  await runWithTenant(ids.tenantId, () => applyManualReceipt(prisma, {
    loanId: ids.loanId, tenantId: ids.tenantId, amount: paid, capturedById: ids.userId,
  }))
  return ids
}

const call = (loanId: string, body: unknown) => waive(
  new NextRequest("http://localhost/api/test", { method: "POST", body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: loanId }) },
)

suite.sequential("small-balance waiver (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })

  it("closes a 75c residue COMPLETED through the guards, and keeps it out of cash collected", async () => {
    const ids = await loanWithResidue(false, SCHEDULE_TOTAL - 75)
    const response = await call(ids.loanId, { reason: REASON })
    expect(response.status).toBe(200)

    const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, include: { repaymentSchedule: true } })
    expect(loan).toMatchObject({
      status: "COMPLETED", closedAt: NOW, totalPaid: SCHEDULE_TOTAL, outstandingPrincipal: 0,
      // The last PAYMENT is still the client's, not the waiver.
      lastPaymentAmount: SCHEDULE_TOTAL - 75,
    })
    expect(loan.repaymentSchedule[0]).toMatchObject({ totalPaid: SCHEDULE_TOTAL, status: "PAID" })
    const waiver = await db.payment.findFirstOrThrow({ where: { loanId: ids.loanId, paymentMethod: "WAIVER" } })
    expect(waiver).toMatchObject({ amount: 75, allocationStatus: "ALLOCATED", reversed: false, capturedBy: ids.userId })

    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: ids.loanId, action: "SMALL_BALANCE_WAIVED" } })
    expect(audit).toMatchObject({ userId: ids.userId })
    expect(audit.newValue).toMatchObject({ amountCents: 75, reason: REASON, paymentId: waiver.id })
    const status = await db.auditLog.findFirstOrThrow({ where: { entityId: ids.loanId, action: "LOAN_STATUS_CHANGED" } })
    expect(status.newValue).toMatchObject({ status: "COMPLETED", reason: "settled_by_small_balance_waiver" })

    const ncr = await runWithTenant(ids.tenantId, () => getNcrReturnData(ids.tenantId, "2026-Q3", NOW))
    expect(ncr.lines.find((line) => line.key === "receipts")).toMatchObject({ count: 1, value: SCHEDULE_TOTAL - 75 })
    expect(ncr.lines.find((line) => line.key === "applied")).toMatchObject({ count: 1, value: SCHEDULE_TOTAL - 75 })
  })

  it("waives a residue that includes default charges, leaving nothing outstanding", async () => {
    const ids = await loanWithResidue(true, SCHEDULE_TOTAL + DEFAULT_INTEREST - 60)
    expect((await call(ids.loanId, { reason: REASON })).status).toBe(200)
    expect(await db.loan.findUniqueOrThrow({ where: { id: ids.loanId } }))
      .toMatchObject({ status: "COMPLETED", totalPaid: SCHEDULE_TOTAL, chargesOutstanding: 0 })
  })

  it("refuses more than R1, a missing reason, and a loan with nothing owed — writing nothing", async () => {
    const big = await loanWithResidue(false, SCHEDULE_TOTAL - 101)
    const tooBig = await call(big.loanId, { reason: REASON })
    expect(tooBig.status).toBe(422)
    expect(await tooBig.json()).toMatchObject({ settlementDueCents: 101 })
    expect((await call(big.loanId, { reason: "  " })).status).toBe(422)
    expect(await db.payment.count({ where: { loanId: big.loanId, paymentMethod: "WAIVER" } })).toBe(0)

    const paid = await loanWithResidue(false, SCHEDULE_TOTAL)
    expect((await call(paid.loanId, { reason: REASON })).status).toBe(409)
    expect(await db.payment.count({ where: { loanId: paid.loanId, paymentMethod: "WAIVER" } })).toBe(0)
  })
})
