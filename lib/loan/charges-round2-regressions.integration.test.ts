/**
 * Further regressions for default charges, run against real Postgres, with the
 * decisions they pin.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/charges-round2-regressions.integration.test.ts
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
import { syncLoanCharges } from "./charges-sync"
import { loadChargesReplay } from "./charges-replay"
import { applyChargesBackfill, planChargesBackfill } from "./charges-backfill"
import { PATCH as setExemption } from "@/app/api/loans/[id]/default-charges-exemption/route"
import { PATCH as reconcile } from "@/app/api/payments/[id]/reconcile/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
async function createLoan() {
  const ids = await createChargesLoan(db, await createChargesTenant(db, true))
  ctx.tenantId = ids.tenantId; ctx.userId = ids.userId
  return ids
}
type Ids = Awaited<ReturnType<typeof createLoan>>
const capture = (ids: Ids, amount: number, over: Record<string, unknown> = {}) =>
  runWithTenant(ids.tenantId, () => applyManualReceipt(payments, { loanId: ids.loanId, tenantId: ids.tenantId, amount, capturedById: ids.userId, ...over }))
const sync = (ids: Ids, asOf: Date) =>
  runWithTenant(ids.tenantId, () => payments.$transaction((tx) => syncLoanCharges(tx, { tenantId: ids.tenantId, loanId: ids.loanId }, asOf, { source: "test" })))
const loanOf = (ids: Ids) => db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, include: { charges: true } })
const req = (body: unknown) => new NextRequest("http://localhost/api/test", { method: "PATCH", body: JSON.stringify(body) })
const override = (ids: Ids) => ({ reason: "Deposit genuinely reached the account on that date.", approvedById: ids.userId })

suite.sequential("charges sync, notice freezing and exemption regressions (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => { vi.useRealTimers(); await db.$disconnect() })
  beforeEach(() => { vi.setSystemTime(NOW) })

  it("a back-dated receipt that settles alongside a later receipt closes the loan on the later value date, and the sync accepts it", async () => {
    const ids = await createLoan()
    vi.setSystemTime(new Date("2026-09-20T10:00:00+02:00"))
    await capture(ids, 100_000)
    vi.setSystemTime(NOW)
    const SEP_10 = new Date("2026-09-10T10:00:00+02:00")
    // The smallest amount which, dated 10 Sep, the replay itself says settles everything.
    const replay = (await runWithTenant(ids.tenantId, () => payments.$transaction((tx) =>
      loadChargesReplay(tx, { tenantId: ids.tenantId, loanId: ids.loanId }, NOW))))!
    const settles = (x: number) => {
      const r = replay.replayAt(NOW, [{ id: "p", amount: x, receivedAt: SEP_10 }])
      return r.unallocated === 0 && r.scheduleAllocated === SCHEDULE_TOTAL && r.interestOutstanding + r.feesOutstanding === 0
    }
    let lo = 1, hi = SCHEDULE_TOTAL
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); const r = replay.replayAt(NOW, [{ id: "p", amount: mid, receivedAt: SEP_10 }]); if (r.scheduleAllocated >= SCHEDULE_TOTAL && r.interestOutstanding + r.feesOutstanding === 0) hi = mid; else lo = mid + 1 }
    expect(settles(lo)).toBe(true)
    const outcome = await capture(ids, lo, { receivedAt: SEP_10, valueDateOverride: override(ids) }).then(() => "accepted", (e: Error) => e.message)
    const loan = await loanOf(ids)
    expect(outcome).toBe("accepted")
    expect(loan.status).toBe("COMPLETED")
    expect(loan.closedAt).toEqual(new Date("2026-09-20T10:00:00+02:00"))
  })

  it("a notice without a frozen amount is refused until --apply stamps today's charge on it, audited; then it never moves", async () => {
    const ids = await createLoan()
    const notice = await db.complianceRecord.create({ data: {
      tenantId: ids.tenantId, type: "SECTION_129_NOTICE", referenceId: ids.loanId, idempotencyKey: `s129-${ids.loanId}`,
      status: "COMPLETED", completedAt: new Date("2026-09-10T10:00:00+02:00"), data: { lifecycle: "ISSUED" },
    } })
    await expect(sync(ids, NOW)).rejects.toThrow(/no frozen admin charge/)
    const plan = await runWithTenant(ids.tenantId, () => planChargesBackfill(payments, ids.tenantId, NOW))
    expect(plan.noticesToStamp).toEqual([{ noticeId: notice.id, loanId: ids.loanId }])

    await runWithTenant(ids.tenantId, () => applyChargesBackfill(payments, ids.tenantId, NOW, { userId: ids.userId, userEmail: "a@test.invalid" }))
    expect((await db.complianceRecord.findUniqueOrThrow({ where: { id: notice.id } })).data)
      .toEqual({ lifecycle: "ISSUED", adminChargeCents: 8_200 })
    expect(await db.auditLog.findFirst({ where: { entityId: notice.id, action: "SECTION_129_CHARGE_STAMPED" } }))
      .toMatchObject({ userId: ids.userId, newValue: { adminChargeCents: 8_200, loanId: ids.loanId, source: "backfill" } })
    const a1 = (await loanOf(ids)).charges.find((c) => c.type === "DEFAULT_ADMIN")?.amount
    await db.tenantConfig.update({ where: { tenantId: ids.tenantId }, data: { defaultAdminChargeCents: 15_000 } })
    await sync(ids, NOW)
    expect(a1).toBe(8_200)
    expect((await loanOf(ids)).charges.find((c) => c.type === "DEFAULT_ADMIN")?.amount).toBe(8_200)
  })

  it("exempting a loan whose client paid the charges splits them off as refund-due, audited, and staff can record the refund", async () => {
    const ids = await createLoan()
    const { payment } = await capture(ids, SCHEDULE_TOTAL + DEFAULT_INTEREST)
    const ex = await setExemption(req({ exempt: true, reason: "Complaint upheld: charges applied in error." }), { params: Promise.resolve({ id: ids.loanId }) })
    expect(ex.status).toBe(200)
    const child = await db.payment.findFirstOrThrow({ where: { parentPaymentId: payment.id } })
    expect(child).toMatchObject({ amount: DEFAULT_INTEREST, allocationStatus: "UNAPPLIED", reconciliationReason: "overpayment_refund_due" })
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } }))
      .toMatchObject({ amount: SCHEDULE_TOTAL, allocationStatus: "ALLOCATED", defaultInterestAllocated: 0, chargeFeesAllocated: 0 })
    expect(await db.auditLog.findFirst({ where: { entityId: payment.id, action: "PAYMENT_REFUND_DUE_SPLIT" } }))
      .toMatchObject({ userId: ids.userId, newValue: expect.objectContaining({ refundDueCents: DEFAULT_INTEREST, refundPaymentId: child.id }) })
    const loan = await loanOf(ids)
    expect(loan).toMatchObject({ defaultChargesExempt: true, status: "COMPLETED", totalPaid: SCHEDULE_TOTAL, chargesAccrued: 0 })
    const rf = await reconcile(req({ action: "record_refund", reason: "Refund charges per complaint", reference: "EFT-REF-1" }), { params: Promise.resolve({ id: child.id }) })
    expect(rf.status).toBe(200)
  })

  it("a loan booked without the fee gets the fallback written on first sync, audited, so a product edit cannot reprice it", async () => {
    const ids = await createLoan()
    await db.loan.update({ where: { id: ids.loanId }, data: { monthlyServiceFee: null } })
    const OCT_5 = new Date("2026-10-05T10:00:00+02:00")
    await sync(ids, OCT_5)
    const f1 = (await loanOf(ids)).charges.find((c) => c.type === "SERVICE_FEE")?.amount
    expect((await loanOf(ids)).monthlyServiceFee).toBe(6_900)
    expect(await db.auditLog.count({ where: { entityId: ids.loanId, action: "LOAN_SERVICE_FEE_RECORDED" } })).toBe(1)
    await db.loanProduct.update({ where: { id: ids.productId }, data: { monthlyServiceFee: 20_000 } })
    await sync(ids, OCT_5)
    const f2 = (await loanOf(ids)).charges.find((c) => c.type === "SERVICE_FEE")?.amount
    expect(f1).toBe(6_900)
    expect(f2).toBe(f1)
  })

  it("a WRITTEN_OFF loan with no writeOffAt is refused", async () => {
    const ids = await createLoan()
    await db.loan.update({ where: { id: ids.loanId }, data: { status: "WRITTEN_OFF", writeOffAt: null } })
    await expect(sync(ids, new Date("2026-12-26T10:00:00+02:00"))).rejects.toThrow(/WRITTEN_OFF with no writeOffAt/)
    expect((await loanOf(ids)).chargesAccrued).toBe(0)
  })
})
