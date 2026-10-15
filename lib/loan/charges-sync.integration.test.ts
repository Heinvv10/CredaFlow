/**
 * Real-Postgres test of default charges through every receipt writer. Mocked
 * Prisma cannot see the migration, the deferred guards, or what each writer
 * actually commits, so this runs the real code against a migrated database.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/charges-sync.integration.test.ts
 */
import { createHmac, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { storeStitchWebhookSecret } from "@/lib/integrations/stitch-webhook.integration-fixture"
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
    user: { id: ctx.userId, email: "charges-it@test.invalid", role: "SUPER_ADMIN" },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
    await runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
  getDefaultTenantId: async () => ctx.tenantId,
}))
vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))
// The portal session and the Stitch API are the only things faked on the
// initiate -> webhook path; the loan, request and receipt rows are real.
const { portal } = vi.hoisted(() => ({ portal: { email: "", stitchId: "" } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: portal.email } })) }))
vi.mock("@/lib/stitch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stitch")>()),
  createStitchPayment: vi.fn(async () => ({ id: portal.stitchId, url: "https://stitch.invalid/pay" })),
}))

import { prisma as payments } from "@/lib/prisma"
import { applyManualReceipt } from "./apply-payment"
import { applyBankTransaction } from "@/lib/bank-sync/apply"
import { PATCH as reverse } from "@/app/api/payments/[id]/reverse/route"
import { PATCH as reconcile } from "@/app/api/payments/[id]/reconcile/route"
import { POST as bulkUpload } from "@/app/api/payments/bulk-upload/route"
import { POST as stitchWebhook } from "@/app/api/portal/payment/webhook/route"
import { POST as initiateStitch } from "@/app/api/portal/payment/initiate/route"
import { PATCH as setExemption } from "@/app/api/loans/[id]/default-charges-exemption/route"
import { finaliseSection129Issuance, type Section129RecordData } from "@/lib/collections/section129-artifact"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

async function createLoan(enabled = true) {
  const ids = await createChargesLoan(db, await createChargesTenant(db, enabled))
  ctx.tenantId = ids.tenantId
  ctx.userId = ids.userId
  return ids
}

type Ids = Awaited<ReturnType<typeof createLoan>>

const capture = (ids: Ids, amount: number, over: Record<string, unknown> = {}) =>
  runWithTenant(ids.tenantId, () => applyManualReceipt(payments, {
    loanId: ids.loanId, tenantId: ids.tenantId, amount, capturedById: ids.userId, ...over,
  }))

async function state(ids: Ids) {
  const loan = await db.loan.findUniqueOrThrow({
    where: { id: ids.loanId }, include: { repaymentSchedule: true, charges: true },
  })
  const receipts = await db.payment.findMany({ where: { loanId: ids.loanId }, orderBy: { createdAt: "asc" } })
  return { loan, receipts, row: loan.repaymentSchedule[0] }
}

async function bankTxn(ids: Ids, amountCents: number, valueDate: Date) {
  const imp = await db.bankStatementImport.create({
    data: { tenantId: ids.tenantId, source: "ABSA_ONLINE", accountRef: "****1234", format: "CSV", fileHash: randomUUID(), rawFilePath: "x" },
  })
  return await db.bankTransaction.create({
    data: {
      tenantId: ids.tenantId, importId: imp.id, postedDate: valueDate, valueDate,
      amountCents, direction: "CREDIT", dedupHash: randomUUID(), matchStatus: "PROPOSED",
    },
  })
}

const req = (body: unknown) => new NextRequest("http://localhost/api/test", {
  method: "PATCH", body: JSON.stringify(body),
})

suite.sequential("default charges through the receipt writers (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })
  beforeEach(() => { vi.setSystemTime(NOW) })
  afterEach(() => { vi.clearAllMocks() })

  it("changes nothing while the tenant's flag is off", async () => {
    const ids = await createLoan(false)
    await capture(ids, 50_000)
    const { loan, receipts, row } = await state(ids)
    expect(loan.totalPaid).toBe(50_000)
    expect(row.totalPaid).toBe(50_000)
    expect(loan.charges).toEqual([])
    expect(loan.chargesAccrued).toBe(0)
    expect(receipts[0]).toMatchObject({ defaultInterestAllocated: 0, chargeFeesAllocated: 0 })
  })

  it("accepts a receipt that pays only default interest and leaves the schedule unpaid", async () => {
    const ids = await createLoan()
    const result = await capture(ids, DEFAULT_INTEREST)
    expect(result.excessPayment).toBeNull()
    // The row handed back is the one the replay split, not the pre-sync insert.
    expect(result.payment.defaultInterestAllocated).toBe(DEFAULT_INTEREST)
    const { loan, receipts, row } = await state(ids)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ allocationStatus: "ALLOCATED", defaultInterestAllocated: DEFAULT_INTEREST })
    expect(loan).toMatchObject({ totalPaid: 0, status: "ACTIVE", chargesAccrued: DEFAULT_INTEREST, chargesOutstanding: 0 })
    expect(row.totalPaid).toBe(0)
    expect(loan.charges.map((c) => [c.type, c.day.toISOString().slice(0, 10), c.amount]))
      .toEqual([["DEFAULT_INTEREST", "2026-09-25", DEFAULT_INTEREST]])
  })

  it("splits off only money beyond charges plus schedule, and completes on both", async () => {
    const ids = await createLoan()
    const result = await capture(ids, SCHEDULE_TOTAL + DEFAULT_INTEREST + 5_000)
    expect(result.excessPayment).toMatchObject({ amount: 5_000, allocationStatus: "UNAPPLIED" })
    const { loan, row } = await state(ids)
    expect(loan).toMatchObject({ totalPaid: SCHEDULE_TOTAL, status: "COMPLETED", chargesOutstanding: 0 })
    expect(row).toMatchObject({ totalPaid: SCHEDULE_TOTAL, status: "PAID" })
  })

  it("does not complete a loan whose receipt covers the schedule but not the charges", async () => {
    const ids = await createLoan()
    await capture(ids, SCHEDULE_TOTAL)
    const { loan } = await state(ids)
    expect(loan).toMatchObject({ status: "ACTIVE", totalPaid: SCHEDULE_TOTAL - DEFAULT_INTEREST })
  })

  it("re-opens charges and the loan when the settling receipt is reversed", async () => {
    const ids = await createLoan()
    const { payment } = await capture(ids, SCHEDULE_TOTAL + DEFAULT_INTEREST)
    expect((await state(ids)).loan.status).toBe("COMPLETED")

    const response = await reverse(req({ reason: "Bounced EFT" }), { params: Promise.resolve({ id: payment.id }) })
    expect(response.status).toBe(200)
    const { loan, row } = await state(ids)
    expect(loan).toMatchObject({
      status: "ACTIVE", closedAt: null, totalPaid: 0,
      chargesAccrued: DEFAULT_INTEREST, chargesOutstanding: DEFAULT_INTEREST,
    })
    expect(row).toMatchObject({ totalPaid: 0, status: "PENDING" })
  })

  it("audits a reversal with the post-sync schedule share, not the gross receipts", async () => {
    const ids = await createLoan()
    await capture(ids, 50_000)
    const { payment } = await capture(ids, 10_000)
    const response = await reverse(req({ reason: "Captured twice" }), { params: Promise.resolve({ id: payment.id }) })
    expect(response.status).toBe(200)
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: payment.id, action: "PAYMENT_REVERSED" },
    })
    // The remaining R500 receipt paid R80 of default interest first.
    expect(audit.newValue).toMatchObject({ loanTotalPaid: 50_000 - DEFAULT_INTEREST })
    expect((await state(ids)).loan.totalPaid).toBe(50_000 - DEFAULT_INTEREST)
  })

  it("charges less default interest for a back-dated receipt", async () => {
    const ids = await createLoan()
    await capture(ids, 100_000, {
      receivedAt: new Date("2026-09-05T10:00:00+02:00"),
      valueDateOverride: { reason: "Deposit reached the account on 5 September.", approvedById: ids.userId },
    })
    const { loan, receipts } = await state(ids)
    // Sep 2..4 on R2,000 = R10.00 paid first; then R990 leaves R1,179 of
    // principal overdue for Sep 5..25: 21 x 117900 x 5% / 30 = R41.27.
    expect(receipts[0].defaultInterestAllocated).toBe(1_000)
    expect(loan.chargesAccrued).toBe(1_000 + 4_127)
    expect(loan.totalPaid).toBe(99_000)
  })

  describe("back-dating that erases default interest needs an override", () => {
    // Captured 20 Oct: dated then, the R2,169 would first pay Sep 2..Oct 19
    // default interest (R157.96) and the 1 Oct service fee (R69.00). Dated
    // 2 Sep it clears the loan before any of that accrues. FLAT contractual
    // interest is untouched by the date, so only the charges rebate (R226.96,
    // above the R100 unreviewed cap) can trip the bound.
    const SEP_2 = new Date("2026-09-02T10:00:00+02:00")
    const CHARGES_REBATE = 15_796 + 6_900
    beforeEach(() => { vi.setSystemTime(new Date("2026-10-20T10:00:00+02:00")) })

    it("on manual capture", async () => {
      const ids = await createLoan()
      await expect(capture(ids, SCHEDULE_TOTAL, { receivedAt: SEP_2 }))
        .rejects.toMatchObject({ code: "INVALID_VALUE_DATE" })
      expect((await state(ids)).receipts).toHaveLength(0)

      await capture(ids, SCHEDULE_TOTAL, {
        receivedAt: SEP_2,
        valueDateOverride: { reason: "Deposit reached the account on 2 September.", approvedById: ids.userId },
      })
      const audit = await db.auditLog.findFirstOrThrow({
        where: { entityId: ids.loanId, action: "PAYMENT_RECORDED" },
      })
      expect(audit.newValue).toMatchObject({ interestRebateCents: CHARGES_REBATE, defaultChargesRebateCents: CHARGES_REBATE })
    })

    it("on a bank-statement deposit", async () => {
      const ids = await createLoan()
      const txn = await bankTxn(ids, SCHEDULE_TOTAL, SEP_2)
      await expect(applyBankTransaction({ txnId: txn.id, loanId: ids.loanId, tenantId: ids.tenantId, userEmail: "x@test.invalid" }))
        .rejects.toThrow(/Back-dating/)
    })

    it("on reconciliation", async () => {
      const ids = await createLoan()
      const held = await db.payment.create({
        data: {
          tenantId: ids.tenantId, loanId: ids.loanId, amount: SCHEDULE_TOTAL, receivedAt: SEP_2,
          allocationStatus: "UNAPPLIED", reconciliationReason: "held",
        },
      })
      const response = await reconcile(
        req({ action: "allocate", reason: "Matched to loan", reference: "BANK-1" }),
        { params: Promise.resolve({ id: held.id }) },
      )
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ requiresValueDateOverride: true })
    })
  })

  it("splits a bank-statement deposit through the replay", async () => {
    const ids = await createLoan()
    const txn = await bankTxn(ids, 20_000, NOW)
    await applyBankTransaction({ txnId: txn.id, loanId: ids.loanId, tenantId: ids.tenantId, userEmail: "x@test.invalid" })
    const { loan, receipts } = await state(ids)
    expect(receipts[0].defaultInterestAllocated).toBe(DEFAULT_INTEREST)
    expect(loan.totalPaid).toBe(20_000 - DEFAULT_INTEREST)
  })

  it("splits a reconciled receipt through the replay", async () => {
    const ids = await createLoan()
    const held = await db.payment.create({
      data: {
        tenantId: ids.tenantId, loanId: ids.loanId, amount: 20_000, receivedAt: NOW,
        allocationStatus: "UNAPPLIED", reconciliationReason: "held",
      },
    })
    const response = await reconcile(
      req({ action: "allocate", reason: "Matched to loan", reference: "BANK-1" }),
      { params: Promise.resolve({ id: held.id }) },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ loanTotalPaid: 20_000 - DEFAULT_INTEREST })
    expect((await state(ids)).receipts[0].defaultInterestAllocated).toBe(DEFAULT_INTEREST)
  })

  it("splits bulk-uploaded receipts, compounding a second row onto the first", async () => {
    const ids = await createLoan()
    const { loan: before } = await state(ids)
    const response = await bulkUpload(new NextRequest("http://localhost/api/test", {
      method: "POST",
      body: JSON.stringify({ rows: [{ reference: before.reference, amount: 50 }, { reference: before.reference, amount: 100 }] }),
    }))
    expect(await response.json()).toMatchObject({ processed: 2, skipped: 0 })
    const { loan, receipts } = await state(ids)
    expect(receipts.map((r) => r.defaultInterestAllocated)).toEqual([5_000, 3_000])
    expect(loan.totalPaid).toBe(15_000 - DEFAULT_INTEREST)
  })

  it("posts the admin charge in the same transaction that confirms a Section 129 notice", async () => {
    const ids = await createLoan()
    await db.tenantConfig.update({ where: { tenantId: ids.tenantId }, data: { defaultAdminPostageCents: 1_500 } })
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
      data: {
        tenantId: ids.tenantId, type: "SECTION_129_NOTICE", referenceId: ids.loanId,
        idempotencyKey: `s129-${ids.loanId}`, status: "PENDING", data: recordData,
      },
    })

    await runWithTenant(ids.tenantId, () => finaliseSection129Issuance({
      reservation: { issuanceId: record.id, idempotencyKey: `s129-${ids.loanId}`, pdfSha256: "a".repeat(64), recordData },
      tenantId: ids.tenantId, loanId: ids.loanId, issuedById: ids.userId,
      emailMessageId: "provider-message-1", issuedAt: reservedAt,
    }))

    const { loan } = await state(ids)
    expect(loan.charges).toContainEqual(expect.objectContaining({
      type: "DEFAULT_ADMIN", amount: 8_200 + 1_500, sourceId: record.id,
    }))
    expect(loan.chargesOutstanding).toBe(DEFAULT_INTEREST + 9_700)
  })

  it("exempting a loan strips its charges in the same transaction, audited with actor and reason", async () => {
    const ids = await createLoan()
    await capture(ids, 50_000)
    expect((await state(ids)).loan.totalPaid).toBe(50_000 - DEFAULT_INTEREST)

    const missing = await setExemption(req({ exempt: true, reason: " " }), { params: Promise.resolve({ id: ids.loanId }) })
    expect(missing.status).toBe(422)

    const reason = "Paid R5,968.00 of R5,968.75; residue is rounding, not default."
    const response = await setExemption(req({ exempt: true, reason }), { params: Promise.resolve({ id: ids.loanId }) })
    expect(response.status).toBe(200)
    const { loan, receipts } = await state(ids)
    expect(loan).toMatchObject({
      defaultChargesExempt: true, defaultChargesExemptReason: reason,
      chargesAccrued: 0, chargesOutstanding: 0, totalPaid: 50_000,
    })
    expect(loan.charges).toEqual([])
    expect(receipts[0]).toMatchObject({ defaultInterestAllocated: 0, chargeFeesAllocated: 0 })
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: ids.loanId, action: "DEFAULT_CHARGES_EXEMPTION_CHANGED" },
    })
    expect(audit).toMatchObject({ userId: ids.userId })
    expect(audit.oldValue).toMatchObject({ defaultChargesExempt: false })
    expect(audit.newValue).toMatchObject({ defaultChargesExempt: true, reason })

    // Lifting it resumes charging from now; the exempt period is never back-charged.
    const lifted = await setExemption(req({ exempt: false, reason: "Exemption entered on the wrong loan." }), { params: Promise.resolve({ id: ids.loanId }) })
    expect(lifted.status).toBe(200)
    expect((await state(ids)).loan).toMatchObject({ defaultChargesExempt: false, defaultChargesExemptEndedAt: NOW, chargesAccrued: 0 })
    const liftAudit = await db.auditLog.findFirstOrThrow({
      where: { entityId: ids.loanId, action: "DEFAULT_CHARGES_EXEMPTION_CHANGED" }, orderBy: { createdAt: "desc" },
    })
    expect(liftAudit.newValue).toMatchObject({ defaultChargesExempt: false, defaultChargesExemptEndedAt: NOW.toISOString() })
  })

  it("splits a Stitch webhook receipt through the replay", async () => {
    const ids = await createLoan()
    await storeStitchWebhookSecret(db, ids.tenantId, "charges-it-secret")
    const stitchId = `stitch_${ids.loanId}`
    await db.stitchPaymentRequest.create({
      data: {
        stitchId, loanId: ids.loanId, clientId: ids.clientId, amount: 20_000,
        redirectUrl: "https://x.invalid", stitchUrl: "https://x.invalid", externalReference: stitchId,
      },
    })
    const body = JSON.stringify({ type: "payment.completed", data: { id: stitchId } })
    const signature = createHmac("sha256", "charges-it-secret").update(body).digest("hex")
    const response = await runWithTenant(ids.tenantId, () => stitchWebhook(new Request("http://localhost/webhook", {
      method: "POST", body, headers: { "x-stitch-signature": signature },
    })))
    expect(response.status).toBe(200)
    const { loan, receipts } = await state(ids)
    expect(receipts[0]).toMatchObject({ allocationStatus: "ALLOCATED", defaultInterestAllocated: DEFAULT_INTEREST })
    expect(loan.totalPaid).toBe(20_000 - DEFAULT_INTEREST)
  })

  it("a client in default pays through the portal: Stitch initiate, then the webhook settles the loan", async () => {
    const ids = await createLoan()
    await db.loan.update({ where: { id: ids.loanId }, data: { status: "DEFAULTED" } })
    portal.email = (await db.client.findUniqueOrThrow({ where: { id: ids.clientId } })).email
    portal.stitchId = `stitch_def_${ids.loanId}`
    await storeStitchWebhookSecret(db, ids.tenantId, "charges-it-secret")
    // The Stitch redirect URL is built from it; CI sets no app env.
    process.env.NEXTAUTH_URL = "http://localhost:3000"

    const started = await initiateStitch(new Request("http://localhost/api/portal/payment/initiate", {
      method: "POST", body: JSON.stringify({ loanId: ids.loanId, amount: (SCHEDULE_TOTAL + DEFAULT_INTEREST) / 100 }),
    }))
    expect(started.status).toBe(200)
    expect(await db.stitchPaymentRequest.findUniqueOrThrow({ where: { stitchId: portal.stitchId } }))
      .toMatchObject({ loanId: ids.loanId, amount: SCHEDULE_TOTAL + DEFAULT_INTEREST })

    const body = JSON.stringify({ type: "payment.completed", data: { id: portal.stitchId } })
    const signature = createHmac("sha256", "charges-it-secret").update(body).digest("hex")
    const settled = await runWithTenant(ids.tenantId, () => stitchWebhook(new Request("http://localhost/webhook", {
      method: "POST", body, headers: { "x-stitch-signature": signature },
    })))
    expect(settled.status).toBe(200)
    const { loan, receipts } = await state(ids)
    expect(receipts[0]).toMatchObject({ allocationStatus: "ALLOCATED", defaultInterestAllocated: DEFAULT_INTEREST })
    expect(loan).toMatchObject({ status: "COMPLETED", totalPaid: SCHEDULE_TOTAL, chargesOutstanding: 0 })
  })

  it("records which writer and which person ran each sync on its audit row", async () => {
    const syncedBy = async (loanId: string) => {
      const row = await db.auditLog.findFirstOrThrow({
        where: { entityId: loanId, action: "LOAN_CHARGES_SYNCED" }, orderBy: { createdAt: "desc" },
      })
      return { source: (row.newValue as { source?: string }).source, userId: row.userId }
    }
    const manual = await createLoan()
    await capture(manual, 20_000)
    expect(await syncedBy(manual.loanId)).toEqual({ source: "manual_capture", userId: manual.userId })

    const bank = await createLoan()
    const txn = await bankTxn(bank, 20_000, NOW)
    await applyBankTransaction({ txnId: txn.id, loanId: bank.loanId, tenantId: bank.tenantId, userId: bank.userId, userEmail: "x@test.invalid" })
    expect(await syncedBy(bank.loanId)).toEqual({ source: "bank_sync", userId: bank.userId })

    const held = await createLoan()
    const payment = await db.payment.create({
      data: { tenantId: held.tenantId, loanId: held.loanId, amount: 20_000, receivedAt: NOW, allocationStatus: "UNAPPLIED", reconciliationReason: "held" },
    })
    await reconcile(req({ action: "allocate", reason: "Matched to loan", reference: "BANK-9" }), { params: Promise.resolve({ id: payment.id }) })
    expect(await syncedBy(held.loanId)).toEqual({ source: "reconcile", userId: held.userId })

    const bulk = await createLoan()
    const { loan: bulkLoan } = await state(bulk)
    await bulkUpload(new NextRequest("http://localhost/api/test", {
      method: "POST", body: JSON.stringify({ rows: [{ reference: bulkLoan.reference, amount: 200 }] }),
    }))
    expect(await syncedBy(bulk.loanId)).toEqual({ source: "bulk_upload", userId: bulk.userId })

    const reversed = await createLoan()
    // Reverse the receipt that paid the charges, so the later one takes them over.
    const { payment: first } = await capture(reversed, 20_000)
    await capture(reversed, 10_000)
    await reverse(req({ reason: "Captured twice" }), { params: Promise.resolve({ id: first.id }) })
    expect(await syncedBy(reversed.loanId)).toEqual({ source: "payment_reversal", userId: reversed.userId })

    const stitch = await createLoan()
    await storeStitchWebhookSecret(db, stitch.tenantId, "charges-it-secret")
    const stitchId = `stitch_actor_${stitch.loanId}`
    await db.stitchPaymentRequest.create({
      data: {
        stitchId, loanId: stitch.loanId, clientId: stitch.clientId, amount: 20_000,
        redirectUrl: "https://x.invalid", stitchUrl: "https://x.invalid", externalReference: stitchId,
      },
    })
    const body = JSON.stringify({ type: "payment.completed", data: { id: stitchId } })
    const signature = createHmac("sha256", "charges-it-secret").update(body).digest("hex")
    await runWithTenant(stitch.tenantId, () => stitchWebhook(new Request("http://localhost/webhook", {
      method: "POST", body, headers: { "x-stitch-signature": signature },
    })))
    expect(await syncedBy(stitch.loanId)).toEqual({ source: "stitch_webhook", userId: null })
  })
})
