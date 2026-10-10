/**
 * Regressions for default charges, run against real Postgres.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/charges-regressions.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import {
  createChargesLoan, createChargesTenant, DEFAULT_INTEREST, NOW, SCHEDULE_TOTAL,
} from "./charges.integration-fixture"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({
    error: null, user: { id: ctx.userId, email: "brk@test.invalid", role: "SUPER_ADMIN" },
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
import { syncLoanCharges } from "./charges-sync"
import { PATCH as reverse } from "@/app/api/payments/[id]/reverse/route"
import { PATCH as setExemption } from "@/app/api/loans/[id]/default-charges-exemption/route"
import { finaliseSection129Issuance, type Section129RecordData } from "@/lib/collections/section129-artifact"
import { collectionsQueueWhere } from "@/lib/collections/queue"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

async function createLoan() {
  const ids = await createChargesLoan(db, await createChargesTenant(db, true))
  ctx.tenantId = ids.tenantId
  ctx.userId = ids.userId
  return ids
}
type Ids = Awaited<ReturnType<typeof createLoan>>
const capture = (ids: Ids, amount: number, over: Record<string, unknown> = {}) =>
  runWithTenant(ids.tenantId, () => applyManualReceipt(payments, {
    loanId: ids.loanId, tenantId: ids.tenantId, amount, capturedById: ids.userId, ...over,
  }))
const sync = (ids: Ids, asOf: Date) =>
  runWithTenant(ids.tenantId, () => payments.$transaction((tx) =>
    syncLoanCharges(tx, { tenantId: ids.tenantId, loanId: ids.loanId }, asOf, { source: "test" })))
const loanOf = (ids: Ids) => db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, include: { charges: true } })
const req = (body: unknown) => new NextRequest("http://localhost/api/test", { method: "PATCH", body: JSON.stringify(body) })
const override = (ids: Ids) => ({ reason: "Deposit genuinely reached the account on that date.", approvedById: ids.userId })

suite.sequential("default charges: back-dated receipts, notice freezing, exemption, fee repricing and reversal invariants (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => { vi.useRealTimers(); await db.$disconnect() })
  beforeEach(() => { vi.setSystemTime(NOW) })

  it("a receipt back-dated to before go-live is refused without an override or keeps the back-charged default interest, and an override audits the full amount rebated", async () => {
    const ids = await createLoan()
    // Go-live 24 Sep; the loan has been overdue since 1 Sep, so it is back-charged from 2 Sep.
    await db.tenantConfig.update({ where: { tenantId: ids.tenantId }, data: { defaultChargesStartedAt: new Date("2026-09-24T09:00:00+02:00") } })
    await sync(ids, NOW)
    expect((await loanOf(ids)).chargesAccrued).toBe(DEFAULT_INTEREST) // R80 booked

    // Staff back-date the full schedule amount to 23 Sep (the day before go-live), no override.
    const outcome = await capture(ids, SCHEDULE_TOTAL, { receivedAt: new Date("2026-09-23T10:00:00+02:00") })
      .then(() => "accepted", (e) => e.code)
    const loan = await loanOf(ids)
    // A 3-day back-date must not silently write off all R80: either refuse without override, or keep the charges.
    expect(outcome === "INVALID_VALUE_DATE" || loan.chargesAccrued >= DEFAULT_INTEREST - 400).toBe(true)

    // With an override it is booked, and the audit states the true amount erased (all R80).
    await capture(ids, SCHEDULE_TOTAL, { receivedAt: new Date("2026-09-23T10:00:00+02:00"), valueDateOverride: override(ids) })
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: ids.loanId, action: "PAYMENT_RECORDED" } })
    expect(audit.newValue).toMatchObject({ defaultChargesRebateCents: DEFAULT_INTEREST })
  })

  it("a receipt back-dated before an existing later receipt is accepted with a value-date override", async () => {
    const ids = await createLoan()
    vi.setSystemTime(new Date("2026-09-20T10:00:00+02:00"))
    await capture(ids, 100_000) // Stitch/EFT on 20 Sep: pays R60 default interest + R940 schedule
    vi.setSystemTime(NOW)
    const before = await loanOf(ids)
    const remaining = SCHEDULE_TOTAL - before.totalPaid
    // A bank line dated 10 Sep is captured late, for the schedule balance the system shows.
    const outcome = await capture(ids, remaining, { receivedAt: new Date("2026-09-10T10:00:00+02:00"), valueDateOverride: override(ids) })
      .then(() => "accepted", (e: Error) => e.message)
    expect(outcome).toBe("accepted")
  })

  it("exempting a settled loan whose receipt paid charges books the R80 as refund-due and returns 200", async () => {
    const ids = await createLoan()
    await capture(ids, SCHEDULE_TOTAL + DEFAULT_INTEREST)
    expect((await loanOf(ids)).status).toBe("COMPLETED")
    // Decision: the route
    // itself splits the charge money off as refund-due. Detail in
    // charges-round2-regressions.integration.test.ts.
    const res = await setExemption(req({ exempt: true, reason: "Complaint upheld: charges applied in error." }), { params: Promise.resolve({ id: ids.loanId }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ refundDue: [expect.objectContaining({ refundDueCents: DEFAULT_INTEREST })] })
    expect((await loanOf(ids)).defaultChargesExempt).toBe(true)
  })

  it("changing the tenant admin charge does not re-price Section 129 letters already issued", async () => {
    const ids = await createLoan()
    // Issued through the real finalise path, which freezes the amount.
    const issuedAt = new Date("2026-09-10T10:00:00+02:00")
    const recordData = {
      lifecycle: "DISPATCHING", loanReference: "LN", clientName: "C T", clientEmail: "c@test.invalid",
      clientFirstName: "C", clientLastName: "T", clientIdNumber: "9001015800080",
      clientAddressLine1: null, clientCity: null, arrearsAmount: SCHEDULE_TOTAL,
      outstandingPrincipal: 200_000, daysInArrears: 9, noticeDate: "2026-09-10",
      fileName: "s129.pdf", pdfSha256: "a".repeat(64), reservedById: ids.userId,
      reservedAt: issuedAt.toISOString(), dispatchStartedAt: issuedAt.toISOString(),
    } satisfies Section129RecordData
    const record = await db.complianceRecord.create({
      data: { tenantId: ids.tenantId, type: "SECTION_129_NOTICE", referenceId: ids.loanId, idempotencyKey: `s129-${ids.loanId}`, status: "PENDING", data: recordData },
    })
    await runWithTenant(ids.tenantId, () => finaliseSection129Issuance({
      reservation: { issuanceId: record.id, idempotencyKey: `s129-${ids.loanId}`, pdfSha256: "a".repeat(64), recordData },
      tenantId: ids.tenantId, loanId: ids.loanId, issuedById: ids.userId, emailMessageId: "provider-message-1", issuedAt,
    }))
    const admin1 = (await loanOf(ids)).charges.find((c) => c.type === "DEFAULT_ADMIN")!.amount
    await db.tenantConfig.update({ where: { tenantId: ids.tenantId }, data: { defaultAdminChargeCents: 15_000 } })
    await sync(ids, NOW)
    const admin2 = (await loanOf(ids)).charges.find((c) => c.type === "DEFAULT_ADMIN")!.amount
    expect(admin1).toBe(8_200)
    expect(admin2).toBe(admin1)
  })

  it("editing the product's monthly fee does not re-price the post-maturity service fee of an existing loan", async () => {
    const ids = await createLoan()
    const OCT_5 = new Date("2026-10-05T10:00:00+02:00")
    await sync(ids, OCT_5)
    const fee1 = (await loanOf(ids)).charges.find((c) => c.type === "SERVICE_FEE")!.amount
    await db.loanProduct.update({ where: { id: ids.productId }, data: { monthlyServiceFee: 20_000 } })
    await sync(ids, OCT_5)
    const fee2 = (await loanOf(ids)).charges.find((c) => c.type === "SERVICE_FEE")!.amount
    expect(fee2).toBe(fee1)
  })

  it("a Section 129 confirmation recorded after the client settled leaves the loan COMPLETED with no outstanding charges", async () => {
    const ids = await createLoan()
    const reservedAt = new Date("2026-09-25T09:00:00+02:00")
    const recordData = {
      lifecycle: "DISPATCHING", loanReference: "LN", clientName: "C T", clientEmail: "c@test.invalid",
      clientFirstName: "C", clientLastName: "T", clientIdNumber: "9001015800080",
      clientAddressLine1: null, clientCity: null, arrearsAmount: SCHEDULE_TOTAL,
      outstandingPrincipal: 200_000, daysInArrears: 24, noticeDate: "2026-09-25",
      fileName: "s129.pdf", pdfSha256: "a".repeat(64), reservedById: ids.userId,
      reservedAt: reservedAt.toISOString(), dispatchStartedAt: reservedAt.toISOString(),
    } satisfies Section129RecordData
    const record = await db.complianceRecord.create({
      data: { tenantId: ids.tenantId, type: "SECTION_129_NOTICE", referenceId: ids.loanId, idempotencyKey: `s129-${ids.loanId}`, status: "PENDING", data: recordData },
    })
    // Client settles everything on the 26th at 10:00 ...
    await capture(ids, SCHEDULE_TOTAL + DEFAULT_INTEREST)
    expect((await loanOf(ids)).status).toBe("COMPLETED")
    // ... and the provider confirmation is recorded afterwards the same day.
    vi.setSystemTime(new Date("2026-09-26T11:00:00+02:00"))
    await runWithTenant(ids.tenantId, () => finaliseSection129Issuance({
      reservation: { issuanceId: record.id, idempotencyKey: `s129-${ids.loanId}`, pdfSha256: "a".repeat(64), recordData },
      tenantId: ids.tenantId, loanId: ids.loanId, issuedById: ids.userId,
      emailMessageId: "provider-message-1", issuedAt: new Date("2026-09-26T11:00:00+02:00"),
    }))
    const loan = await loanOf(ids)
    expect(loan.status).toBe("COMPLETED")
    expect(loan.chargesOutstanding).toBe(0)
  })

  it("with default charges switched off, a reversal keeps totalPaid equal to SUM(amount - splits)", async () => {
    const ids = await createLoan()
    await capture(ids, 50_000) // R80 of this is default interest
    const { payment } = await capture(ids, 10_000)
    await db.tenantConfig.update({ where: { tenantId: ids.tenantId }, data: { defaultChargesEnabled: false } })
    const res = await reverse(req({ reason: "Captured twice in error" }), { params: Promise.resolve({ id: payment.id }) })
    expect(res.status).toBe(200)
    const loan = await loanOf(ids)
    const live = await db.payment.findMany({ where: { loanId: ids.loanId, reversed: false, allocationStatus: "ALLOCATED" } })
    const identity = live.reduce((s, p) => s + p.amount - p.defaultInterestAllocated - p.chargeFeesAllocated, 0)
    expect(loan.totalPaid).toBe(identity)
  })

  it("a loan whose schedule is paid but charges are owed is in the collections queue only while charges are live", async () => {
    const tenant = await createChargesTenant(db, true)
    const chargesOnly = await createChargesLoan(db, tenant)
    const overdue = await createChargesLoan(db, tenant)
    const current = await createChargesLoan(db, tenant)
    await db.loan.update({
      where: { id: chargesOnly.loanId },
      data: { daysInArrears: 0, arrearsAmount: 0, outstandingPrincipal: 0, chargesOutstanding: 5_000 },
    })
    await db.loan.update({ where: { id: overdue.loanId }, data: { daysInArrears: 25, arrearsAmount: SCHEDULE_TOTAL } })
    await db.loan.update({ where: { id: current.loanId }, data: { daysInArrears: 0, arrearsAmount: 0 } })
    const queue = async (live: boolean) => (await db.loan.findMany({
      where: collectionsQueueWhere(tenant.tenantId, live), select: { id: true }, orderBy: { id: "asc" },
    })).map((loan) => loan.id)

    expect(await queue(true)).toEqual([chargesOnly.loanId, overdue.loanId].sort())
    expect(await queue(false)).toEqual([overdue.loanId])
  })

  it("FOLLOW-UP A: a loan booked by an image that predates the fee column inserts, and replays on the fallback fee", async () => {
    const tenant = await createChargesTenant(db, true)
    const template = await createChargesLoan(db, tenant)
    const app = await db.loanApplication.findFirstOrThrow({ where: { clientId: template.clientId } })
    // Reuse the fixture's client and application for the old-shape row.
    await db.repaymentSchedule.deleteMany({ where: { loanId: template.loanId } })
    await db.loan.delete({ where: { id: template.loanId } })
    const loanId = `${template.loanId}_old`
    // The INSERT an older image issues: every column it knows, none of the new ones.
    await db.$executeRaw`
      INSERT INTO "Loan" ("id", "tenantId", "reference", "applicationId", "clientId", "productId", "principal",
        "totalInterest", "initiationFee", "totalRepayable", "outstandingPrincipal", "startDate", "maturityDate",
        "interestRatePm", "interestModel", "status", "updatedAt")
      VALUES (${loanId}, ${tenant.tenantId}, ${`LN-OLD-${loanId}`}, ${app.id}, ${template.clientId}, ${tenant.productId},
        200000, 10000, 0, ${SCHEDULE_TOTAL}, 200000, ${new Date("2026-08-01T10:00:00+02:00")},
        ${new Date("2026-09-01T10:00:00+02:00")}, 0.05, 'FLAT', 'ACTIVE', now())`
    await db.repaymentSchedule.create({
      data: {
        tenantId: tenant.tenantId, loanId, installmentNo: 1, dueDate: new Date("2026-09-01T10:00:00+02:00"),
        principalDue: 200_000, interestDue: 10_000, feesDue: 6_900, totalDue: SCHEDULE_TOTAL,
      },
    })
    expect((await db.loan.findUniqueOrThrow({ where: { id: loanId } })).monthlyServiceFee).toBeNull()

    // A month past maturity the product's R69 fee posts on 1 October.
    vi.setSystemTime(new Date("2026-10-02T10:00:00+02:00"))
    await runWithTenant(tenant.tenantId, () => db.$transaction((tx) =>
      syncLoanCharges(tx as never, { tenantId: tenant.tenantId, loanId }, new Date(), { source: "test" })))
    vi.setSystemTime(NOW)
    const fees = await db.loanCharge.findMany({ where: { loanId, type: "SERVICE_FEE" } })
    expect(fees.map((fee) => fee.amount)).toEqual([6_900])
  })
})
