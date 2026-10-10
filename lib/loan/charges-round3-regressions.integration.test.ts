/**
 * Further regressions for default charges, run against real Postgres (each
 * pins a defect that was fixed, or probes a guarantee that holds).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/charges-round3-regressions.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesLoan, createChargesTenant, DEFAULT_INTEREST, NOW, SCHEDULE_TOTAL } from "./charges.integration-fixture"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({ error: null, user: { id: ctx.userId, email: "brk@test.invalid", role: "SUPER_ADMIN" } })),
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
import { applyChargesBackfill } from "./charges-backfill"
import { waiveSmallBalance } from "./small-balance-waiver"
import { loanSettlementFigures } from "./charges-summary"
import { PATCH as setExemption } from "@/app/api/loans/[id]/default-charges-exemption/route"
import { finaliseSection129Issuance, type Section129RecordData } from "@/lib/collections/section129-artifact"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
async function createLoan(enabled = true) {
  const ids = await createChargesLoan(db, await createChargesTenant(db, enabled))
  ctx.tenantId = ids.tenantId; ctx.userId = ids.userId
  return ids
}
type Ids = Awaited<ReturnType<typeof createLoan>>
const capture = (ids: Ids, amount: number, over: Record<string, unknown> = {}) =>
  runWithTenant(ids.tenantId, () => applyManualReceipt(payments, { loanId: ids.loanId, tenantId: ids.tenantId, amount, capturedById: ids.userId, ...over }))
const loanOf = (ids: Ids) => db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, include: { charges: true, repaymentSchedule: true } })
const req = (body: unknown) => new NextRequest("http://localhost/api/test", { method: "PATCH", body: JSON.stringify(body) })

suite.sequential("charges waiver exemption, sweep race and settle-amount regressions (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => { vi.useRealTimers(); await db.$disconnect() })
  beforeEach(() => { vi.setSystemTime(NOW) })

  it("exempting a loan closed by a small-balance waiver retires the waiver and refunds exactly the excess cash", async () => {
    const ids = await createLoan()
    await capture(ids, SCHEDULE_TOTAL + DEFAULT_INTEREST - 50) // 50c short of settling
    await runWithTenant(ids.tenantId, () => waiveSmallBalance(payments, { tenantId: ids.tenantId, loanId: ids.loanId, reason: "rounding residue", userId: ids.userId, userEmail: null }))
    expect((await loanOf(ids)).status).toBe("COMPLETED")
    const res = await setExemption(req({ exempt: true, reason: "Complaint upheld: charges applied in error." }), { params: Promise.resolve({ id: ids.loanId }) })
    const pays = await db.payment.findMany({ where: { loanId: ids.loanId } })
    const cashIn = SCHEDULE_TOTAL + DEFAULT_INTEREST - 50
    const refundDue = pays.filter((p) => p.allocationStatus === "UNAPPLIED").reduce((s, p) => s + p.amount, 0)
    // Nothing owed any more, so the client is owed back exactly the cash beyond the schedule — not the waived cents too.
    expect(res.status).toBe(200)
    expect(refundDue).toBe(cashIn - SCHEDULE_TOTAL)
    const allocatedCash = pays.filter((p) => p.paymentMethod !== "WAIVER" && !p.reversed && p.allocationStatus === "ALLOCATED")
      .reduce((s, p) => s + p.amount, 0)
    expect(allocatedCash + refundDue).toBe(cashIn)
    expect(pays.filter((p) => p.paymentMethod === "WAIVER").map((p) => p.reversed)).toEqual([true])
    expect(await db.auditLog.count({ where: { action: "PAYMENT_WAIVER_RETIRED", tenantId: ids.tenantId } })).toBe(1)
  })

  it("a receipt landing between --apply's plan and its sweep cannot slip a lowered totalPaid through unaccepted", async () => {
    // First go-live (the only go-live now): the plan sees an overdue loan with
    // no receipts, so nothing needs accepting.
    const ids = await createLoan(false)
    const actor = { userId: ids.userId, userEmail: "brk@test.invalid" }
    let injected = false
    const racing = new Proxy(payments, {
      get(target, prop, recv) {
        if (prop === "$transaction" && !injected) {
          return async (...args: unknown[]) => {
            injected = true
            // The client pays R500 (booked to the schedule, charges still off) while --apply is between plan and switch-on.
            await capture(ids, 50_000)
            return (target.$transaction as (...a: unknown[]) => unknown)(...args)
          }
        }
        return Reflect.get(target, prop, recv)
      },
    })
    const result = await runWithTenant(ids.tenantId, () => applyChargesBackfill(racing as typeof payments, ids.tenantId, NOW, actor))
    const loan = await loanOf(ids)
    // Charging the default open at go-live would move R80 of that receipt onto
    // default interest: unaccepted, so the sweep refuses and books nothing.
    expect(loan.totalPaid).toBe(50_000)
    expect(await db.auditLog.count({ where: { entityId: ids.loanId, action: "DEFAULT_CHARGES_CHANGE_ACCEPTED" } })).toBe(0)
    expect(result).toMatchObject({ failures: [{ loanId: ids.loanId, error: expect.stringMatching(/already booked to the instalments onto charges/) }] })
  })

  it("an S129 whose provider issuedAt precedes a settling receipt, recorded after it, does not re-open the settled loan", async () => {
    const ids = await createLoan()
    const reservedAt = new Date("2026-09-26T09:00:00+02:00")
    const recordData = {
      lifecycle: "DISPATCHING", loanReference: "LN", clientName: "C T", clientEmail: "c@test.invalid",
      clientFirstName: "C", clientLastName: "T", clientIdNumber: "9001015800080",
      clientAddressLine1: null, clientCity: null, arrearsAmount: SCHEDULE_TOTAL,
      outstandingPrincipal: 200_000, daysInArrears: 25, noticeDate: "2026-09-26",
      fileName: "s129.pdf", pdfSha256: "a".repeat(64), reservedById: ids.userId,
      reservedAt: reservedAt.toISOString(), dispatchStartedAt: reservedAt.toISOString(),
    } satisfies Section129RecordData
    const record = await db.complianceRecord.create({ data: { tenantId: ids.tenantId, type: "SECTION_129_NOTICE", referenceId: ids.loanId, idempotencyKey: `s129-${ids.loanId}`, status: "PENDING", data: recordData } })
    await capture(ids, SCHEDULE_TOTAL + DEFAULT_INTEREST) // 10:00, the full settlement quoted
    expect((await loanOf(ids)).status).toBe("COMPLETED")
    vi.setSystemTime(new Date("2026-09-26T11:00:00+02:00"))
    await runWithTenant(ids.tenantId, () => finaliseSection129Issuance({
      reservation: { issuanceId: record.id, idempotencyKey: `s129-${ids.loanId}`, pdfSha256: "a".repeat(64), recordData },
      tenantId: ids.tenantId, loanId: ids.loanId, issuedById: ids.userId, emailMessageId: "m-1",
      issuedAt: new Date("2026-09-26T09:30:00+02:00"),
    }))
    const loan = await loanOf(ids)
    expect(loan.status).toBe("COMPLETED")
    expect(loan.chargesOutstanding).toBe(0)
  })

  it("documents' Total Amount to Settle is exactly what a writer accepts to close (FLAT overdue with charges)", async () => {
    const ids = await createLoan()
    await capture(ids, 30_000)
    const loan = await loanOf(ids)
    const figures = await runWithTenant(ids.tenantId, () => loanSettlementFigures(payments as never, loan as never, NOW))
    const minus = await capture(ids, figures.totalToSettle - 1)
    const afterMinus = await loanOf(ids)
    await capture(ids, 1)
    const final = await loanOf(ids)
    expect(minus.excessPayment).toBeNull()
    expect(afterMinus.status).toBe("ACTIVE")
    expect(final.status).toBe("COMPLETED")
  })
})
