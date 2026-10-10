/**
 * Real-Postgres test of the sync's structural guard: in
 * normal mode no caller may lower Loan.totalPaid (move money already booked
 * to the instalments onto charges) or re-open a settled loan. Each caller
 * class refuses — writes nothing, 409 from routes, a per-loan failure from
 * the sweep — and only a reversal may.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/charges-sync-guard.integration.test.ts
 */
import { createHmac, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesLoan, createChargesTenant, DEFAULT_INTEREST, NOW, SCHEDULE_TOTAL } from "./charges.integration-fixture"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({ error: null, user: { id: ctx.userId, email: "guard@test.invalid", role: "SUPER_ADMIN" } })),
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
import { sweepTenantCharges } from "./charges-sweep"
import { POST as capturePayment } from "@/app/api/payments/route"
import { PAYMENT_IDEMPOTENCY_HEADER } from "@/lib/payments/idempotency"
import { PATCH as reverse } from "@/app/api/payments/[id]/reverse/route"
import { PATCH as setExemption } from "@/app/api/loans/[id]/default-charges-exemption/route"
import { POST as waive } from "@/app/api/loans/[id]/small-balance-waiver/route"
import { finaliseSection129Issuance, type Section129RecordData } from "@/lib/collections/section129-artifact"
import { POST as stitchWebhook } from "@/app/api/portal/payment/webhook/route"
import { POST as bulkUpload } from "@/app/api/payments/bulk-upload/route"
import { applyBankTransaction } from "@/lib/bank-sync/apply"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

async function createLoan() {
  const ids = await createChargesLoan(db, await createChargesTenant(db, true))
  ctx.tenantId = ids.tenantId
  ctx.userId = ids.userId
  return ids
}
type Ids = Awaited<ReturnType<typeof createLoan>>
const capture = (ids: Ids, amount: number) =>
  runWithTenant(ids.tenantId, () => applyManualReceipt(payments, { loanId: ids.loanId, tenantId: ids.tenantId, amount, capturedById: ids.userId }))
const req = (method: string, body: unknown) => new NextRequest("http://localhost/api/test", { method, body: JSON.stringify(body) })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

/** Stored Loan.totalPaid 1 rand above what the receipts allocate: any sync would lower it. */
async function overstate(ids: Ids) {
  const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId } })
  await db.loan.update({ where: { id: ids.loanId }, data: { totalPaid: loan.totalPaid + 100 } })
  return await snapshot(ids)
}
const snapshot = async (ids: Ids) => ({
  loan: await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, include: { charges: true, repaymentSchedule: true } }),
  payments: await db.payment.count({ where: { loanId: ids.loanId } }),
})

suite.sequential("sync guard: no caller moves booked money or re-opens a settled loan (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })
  beforeEach(() => { vi.setSystemTime(NOW) })

  it("a receipt writer: 409, nothing written", async () => {
    const ids = await createLoan()
    await capture(ids, 20_000)
    const before = await overstate(ids)
    const res = await capturePayment(new NextRequest("http://localhost/api/payments", {
      method: "POST", body: JSON.stringify({ loanId: ids.loanId, amount: 10_000 }),
      headers: { [PAYMENT_IDEMPOTENCY_HEADER]: `guard-${ids.loanId}` },
    }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already booked to the instalments onto charges/)
    expect(await snapshot(ids)).toEqual(before)
  })

  it("the nightly sweep: a per-loan failure, nothing written", async () => {
    const ids = await createLoan()
    await capture(ids, 20_000)
    const before = await overstate(ids)
    const result = await runWithTenant(ids.tenantId, () => sweepTenantCharges(payments, ids.tenantId, NOW, { source: "cron" }))
    expect(result.failures).toEqual([{ loanId: ids.loanId, error: expect.stringMatching(/refused/) }])
    expect(await snapshot(ids)).toEqual(before)
  })

  it("the exemption route: 409, nothing written", async () => {
    const ids = await createLoan()
    await capture(ids, 20_000)
    const before = await overstate(ids)
    const res = await setExemption(req("PATCH", { exempt: false, reason: "Reviewed: charges stand." }), params(ids.loanId))
    expect(res.status).toBe(409)
    expect(await snapshot(ids)).toEqual(before)
  })

  it("the small-balance waiver route: 409, nothing written", async () => {
    const ids = await createLoan()
    // R1.50 short of settling; stored as R0.50 short.
    await capture(ids, SCHEDULE_TOTAL + DEFAULT_INTEREST - 150)
    const before = await overstate(ids)
    const res = await waive(req("POST", { reason: "rounding residue" }), params(ids.loanId))
    expect(res.status).toBe(409)
    expect(await snapshot(ids)).toEqual(before)
  })

  it("a Section 129 finalise: the issuance is still recorded; the refusal is audited and flagged, no charge written", async () => {
    const ids = await createLoan()
    await capture(ids, 20_000)
    const reservedAt = new Date("2026-09-26T09:00:00+02:00")
    const recordData = {
      lifecycle: "DISPATCHING", loanReference: "LN", clientName: "C T", clientEmail: "c@test.invalid",
      clientFirstName: "C", clientLastName: "T", clientIdNumber: "9001015800080",
      clientAddressLine1: null, clientCity: null, arrearsAmount: SCHEDULE_TOTAL,
      outstandingPrincipal: 200_000, daysInArrears: 25, noticeDate: "2026-09-26",
      fileName: "s129.pdf", pdfSha256: "a".repeat(64), reservedById: ids.userId,
      reservedAt: reservedAt.toISOString(), dispatchStartedAt: reservedAt.toISOString(),
    } satisfies Section129RecordData
    const record = await db.complianceRecord.create({
      data: { tenantId: ids.tenantId, type: "SECTION_129_NOTICE", referenceId: ids.loanId, idempotencyKey: `s129-${ids.loanId}`, status: "PENDING", data: recordData },
    })
    const before = await overstate(ids)
    await runWithTenant(ids.tenantId, () => finaliseSection129Issuance({
      reservation: { issuanceId: record.id, idempotencyKey: `s129-${ids.loanId}`, pdfSha256: "a".repeat(64), recordData },
      tenantId: ids.tenantId, loanId: ids.loanId, issuedById: ids.userId, emailMessageId: "m-1", issuedAt: NOW,
    }))
    const issued = await db.complianceRecord.findUniqueOrThrow({ where: { id: record.id } })
    expect(issued.status).toBe("COMPLETED")
    expect(issued.data).toMatchObject({ lifecycle: "ISSUED", chargesNotDerived: expect.stringMatching(/refused/) })
    expect(await db.auditLog.findFirst({ where: { entityId: ids.loanId, action: "SECTION_129_CHARGES_NOT_DERIVED" } }))
      .toMatchObject({ newValue: expect.objectContaining({ issuanceId: record.id, reason: expect.stringMatching(/refused/) }) })
    const after = await snapshot(ids)
    // The stage advance is the issuance's own effect; nothing charges-related moved.
    expect({ ...after.loan, collectionsStage: before.loan.collectionsStage, collectionsStageUpdatedAt: before.loan.collectionsStageUpdatedAt, updatedAt: before.loan.updatedAt })
      .toEqual(before.loan)
  })

  it("a reversal may: it is the one writer that takes money back off the schedule", async () => {
    const ids = await createLoan()
    // The first receipt pays the R80 of default interest; reversing it leaves
    // the second to pay it, taking R80 of that receipt off the instalment.
    const { payment } = await capture(ids, 20_000)
    await capture(ids, 10_000)
    const res = await reverse(req("PATCH", { reason: "Bounced" }), params(payment.id))
    expect(res.status).toBe(200)
    expect((await db.loan.findUniqueOrThrow({ where: { id: ids.loanId } })).totalPaid).toBe(10_000 - DEFAULT_INTEREST)
  })

  /** The money is recorded, held for reconciliation with the reason, and nothing else moved. */
  async function expectHeld(ids: Ids, before: Awaited<ReturnType<typeof snapshot>>, amount: number, source: string) {
    const held = await db.payment.findMany({ where: { loanId: ids.loanId, allocationStatus: "UNAPPLIED" } })
    expect(held).toEqual([expect.objectContaining({ amount, reconciliationReason: "charges_refused" })])
    expect(await db.auditLog.findFirst({ where: { entityId: ids.loanId, action: "PAYMENT_RECORDED" }, orderBy: { createdAt: "desc" } }))
      .toMatchObject({ newValue: expect.objectContaining({
        paymentId: held[0].id, source, allocated: false, reconciliationRequired: true, reason: "charges_refused",
        detail: expect.stringMatching(/refused/),
      }) })
    const after = await snapshot(ids)
    expect(after.loan).toEqual(before.loan)
    expect(after.payments).toBe(before.payments + 1)
    return held[0]
  }

  it("the Stitch webhook holds money the replay refuses, and a replayed webhook books nothing more", async () => {
    const ids = await createLoan()
    await capture(ids, 20_000)
    const before = await overstate(ids)
    process.env.STITCH_WEBHOOK_SECRET = "guard-secret"
    const stitchId = `stitch_guard_${ids.loanId}`
    await db.stitchPaymentRequest.create({
      data: { stitchId, loanId: ids.loanId, clientId: ids.clientId, amount: 10_000, redirectUrl: "https://x.invalid", stitchUrl: "https://x.invalid", externalReference: stitchId },
    })
    const body = JSON.stringify({ type: "payment.completed", data: { id: stitchId } })
    const call = () => runWithTenant(ids.tenantId, () => stitchWebhook(new Request("http://localhost/webhook", {
      method: "POST", body, headers: { "x-stitch-signature": createHmac("sha256", "guard-secret").update(body).digest("hex") },
    })))
    expect((await call()).status).toBe(200)
    await expectHeld(ids, before, 10_000, "stitch_webhook")
    expect((await db.stitchPaymentRequest.findUniqueOrThrow({ where: { stitchId } })).status).toBe("COMPLETED")
    expect(await (await call()).json()).toMatchObject({ replayed: true })
    expect(await db.payment.count({ where: { loanId: ids.loanId } })).toBe(before.payments + 1)
  })

  it("a bank-statement line the replay refuses is held and linked, not dropped", async () => {
    const ids = await createLoan()
    await capture(ids, 20_000)
    const before = await overstate(ids)
    const imp = await db.bankStatementImport.create({
      data: { tenantId: ids.tenantId, source: "ABSA_ONLINE", accountRef: "****1234", format: "CSV", fileHash: randomUUID(), rawFilePath: "x" },
    })
    const txn = await db.bankTransaction.create({
      data: { tenantId: ids.tenantId, importId: imp.id, postedDate: NOW, valueDate: NOW, amountCents: 10_000, direction: "CREDIT", dedupHash: randomUUID(), matchStatus: "PROPOSED" },
    })
    const { paymentId } = await applyBankTransaction({ txnId: txn.id, loanId: ids.loanId, tenantId: ids.tenantId, userId: ids.userId, userEmail: "x@test.invalid" })
    const held = await expectHeld(ids, before, 10_000, "bank_sync")
    expect(paymentId).toBe(held.id)
    expect(await db.bankTransaction.findUniqueOrThrow({ where: { id: txn.id } }))
      .toMatchObject({ matchStatus: "MATCHED", paymentId: held.id, matchedLoanId: ids.loanId })
  })

  it("a bulk-upload row the replay refuses is held and reported per row; other loans still book", async () => {
    const bad = await createLoan()
    await capture(bad, 20_000)
    const before = await overstate(bad)
    const good = await createChargesLoan(db, { tenantId: bad.tenantId, userId: bad.userId, productId: bad.productId })
    const ref = async (id: string) => (await db.loan.findUniqueOrThrow({ where: { id } })).reference
    const res = await bulkUpload(new NextRequest("http://localhost/api/test", {
      method: "POST", body: JSON.stringify({ rows: [{ reference: await ref(bad.loanId), amount: 100 }, { reference: await ref(good.loanId), amount: 200 }] }),
    }))
    const body = await res.json()
    expect(body).toMatchObject({
      processed: 1,
      held: [expect.objectContaining({ row: 1, amount: 10_000, reason: expect.stringMatching(/refused/) })],
    })
    await expectHeld(bad, before, 10_000, "bulk_upload")
    expect(await db.payment.count({ where: { loanId: good.loanId, allocationStatus: "ALLOCATED" } })).toBe(1)
    expect(await db.auditLog.findFirst({ where: { tenantId: bad.tenantId, action: "BULK_PAYMENTS_UPLOADED" } }))
      .toMatchObject({ newValue: expect.objectContaining({ processed: 1, held: 1 }) })
  })

  it("K6: bulk-upload money above what settles a loan is recorded refund-due, never skipped", async () => {
    const ids = await createLoan()
    const ref = (await db.loan.findUniqueOrThrow({ where: { id: ids.loanId } })).reference
    const settle = SCHEDULE_TOTAL + DEFAULT_INTEREST
    const res = await bulkUpload(new NextRequest("http://localhost/api/test", {
      method: "POST", body: JSON.stringify({ rows: [{ reference: ref, amount: (settle + 500) / 100 }, { reference: ref, amount: 30 }] }),
    }))
    const body = await res.json()
    expect(body).toMatchObject({ processed: 1, skipped: 0, refundDue: [
      expect.objectContaining({ row: 1, amount: 500 }), expect.objectContaining({ row: 2, amount: 3_000 }),
    ] })
    // By amount, not createdAt: the settling payment and its refund-due
    // remainder can be stamped in the same millisecond.
    const pays = await db.payment.findMany({ where: { loanId: ids.loanId }, orderBy: { amount: "desc" } })
    expect(pays.map((p) => [p.amount, p.allocationStatus, p.reconciliationReason])).toEqual([
      [settle, "ALLOCATED", null], [3_000, "UNAPPLIED", "overpayment_refund_due"], [500, "UNAPPLIED", "overpayment_refund_due"],
    ])
    expect(pays[2].parentPaymentId).toBe(pays[0].id)
    expect(await db.loan.findUniqueOrThrow({ where: { id: ids.loanId } })).toMatchObject({ status: "COMPLETED", totalPaid: SCHEDULE_TOTAL })
  })
})
