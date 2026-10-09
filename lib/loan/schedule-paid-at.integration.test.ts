/**
 * Real-Postgres test of RepaymentSchedule.paidAt through the receipt writers.
 *
 * A row's paidAt is the value date of the live receipt that completed it when
 * the loan's receipts are replayed in the books' order. A reversal, or a
 * receipt dated before one already on the loan, changes which receipt that is
 * for a row whose amounts and status stay the same — so the writers' own
 * "skip unchanged rows" loops can never see it. Only auth and the tenant frame
 * are stubbed.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/schedule-paid-at.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesTenant } from "./charges.integration-fixture"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({
    error: null,
    user: { id: ctx.userId, email: "paidat-it@test.invalid", role: "SUPER_ADMIN" },
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
import { PATCH as reverse } from "@/app/api/payments/[id]/reverse/route"
import { PATCH as reconcile } from "@/app/api/payments/[id]/reconcile/route"
import { POST as bulkUpload } from "@/app/api/payments/bulk-upload/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

// Two R500 interest-free instalments, due 1 Jul and 1 Aug; booked on 25 Aug.
const NOW = new Date("2026-08-25T10:00:00+02:00")
const JUN_29 = new Date("2026-06-29T10:00:00+02:00")
const JUL_20 = new Date("2026-07-20T10:00:00+02:00")
const AUG_05 = new Date("2026-08-05T10:00:00+02:00")
const INSTALMENT = 50_000

async function createLoan(chargesLive = false) {
  const tenant = await createChargesTenant(db, chargesLive)
  ctx.tenantId = tenant.tenantId
  ctx.userId = tenant.userId
  const n = randomUUID().replaceAll("-", "").slice(0, 12)
  const product = await db.loanProduct.create({
    data: {
      tenantId: tenant.tenantId, code: `ZERO-${n}`, name: "Zero", productType: "PERSONAL",
      minAmount: 1, maxAmount: 10_000_000, minTermDays: 30, maxTermDays: 365,
      interestRatePm: 0, interestModel: "FLAT",
    },
  })
  const client = await db.client.create({
    data: {
      tenantId: tenant.tenantId, idNumber: `91${n.slice(0, 11)}`, firstName: "Paid", lastName: "At",
      email: `${n}@client.invalid`, phone: "0820000000",
    },
  })
  const app = await db.loanApplication.create({
    data: {
      tenantId: tenant.tenantId, reference: `APP-${n}`, clientId: client.id, productId: product.id,
      appliedAmount: 2 * INSTALMENT, appliedTermDays: 61,
    },
  })
  const loan = await db.loan.create({
    data: {
      tenantId: tenant.tenantId, reference: `LN-${n}`, applicationId: app.id, clientId: client.id,
      productId: product.id, principal: 2 * INSTALMENT, totalInterest: 0, initiationFee: 0,
      totalRepayable: 2 * INSTALMENT, outstandingPrincipal: 2 * INSTALMENT,
      startDate: new Date("2026-06-01T10:00:00+02:00"), maturityDate: new Date("2026-08-01T10:00:00+02:00"),
      interestRatePm: 0, interestModel: "FLAT", status: "ACTIVE",
      repaymentSchedule: {
        create: [1, 2].map((installmentNo) => ({
          tenantId: tenant.tenantId, installmentNo,
          dueDate: new Date(`2026-0${installmentNo + 6}-01T10:00:00+02:00`),
          principalDue: INSTALMENT, interestDue: 0, feesDue: 0, totalDue: INSTALMENT,
        })),
      },
    },
  })
  return { tenantId: tenant.tenantId, userId: tenant.userId, loanId: loan.id, reference: loan.reference }
}

type Ids = Awaited<ReturnType<typeof createLoan>>

const capture = async (ids: Ids, amount: number, receivedAt: Date) =>
  (await runWithTenant(ids.tenantId, () => applyManualReceipt(payments, {
    loanId: ids.loanId, tenantId: ids.tenantId, amount, receivedAt, capturedById: ids.userId,
  }))).payment

const req = (body: unknown) => new NextRequest("http://localhost/api/test", {
  method: "PATCH", body: JSON.stringify(body),
})

async function reverseReceipt(id: string) {
  const response = await reverse(req({ reason: "Debit order returned unpaid" }), { params: Promise.resolve({ id }) })
  expect(response.status).toBe(200)
}

/** [status, totalPaid, paidAt] per instalment. */
async function rows(ids: Ids) {
  const schedule = await db.repaymentSchedule.findMany({ where: { loanId: ids.loanId }, orderBy: { installmentNo: "asc" } })
  return schedule.map((row) => [row.status, row.totalPaid, row.paidAt?.toISOString() ?? null])
}

suite.sequential("RepaymentSchedule.paidAt through the receipt writers (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })
  beforeEach(() => { vi.setSystemTime(NOW) })

  describe("reversal", () => {
    it("re-dates an instalment a LATER receipt now covers, though its amounts and status did not change", async () => {
      const ids = await createLoan()
      const onTime = await capture(ids, INSTALMENT, JUN_29)
      await capture(ids, INSTALMENT, JUL_20)
      expect(await rows(ids)).toEqual([
        ["PAID", INSTALMENT, JUN_29.toISOString()],
        ["PAID", INSTALMENT, JUL_20.toISOString()],
      ])

      // The on-time debit order bounces. Instalment 1 is now paid by the
      // 20 Jul receipt: three weeks late, not on time.
      await reverseReceipt(onTime.id)
      expect(await rows(ids)).toEqual([
        ["PAID", INSTALMENT, JUL_20.toISOString()],
        ["PENDING", 0, null],
      ])
    })

    it("clears paidAt when the only receipt is reversed", async () => {
      const ids = await createLoan()
      const only = await capture(ids, INSTALMENT, JUN_29)
      await reverseReceipt(only.id)
      expect(await rows(ids)).toEqual([["PENDING", 0, null], ["PENDING", 0, null]])
    })

    it("follows each of several reversals, through partly paid instalments", async () => {
      const ids = await createLoan()
      const first = await capture(ids, 30_000, JUN_29)
      const second = await capture(ids, 40_000, JUL_20)
      await capture(ids, 30_000, AUG_05)
      expect(await rows(ids)).toEqual([
        ["PAID", INSTALMENT, JUL_20.toISOString()],
        ["PAID", INSTALMENT, AUG_05.toISOString()],
      ])

      // 20 Jul's R400 and R100 of 5 Aug's R300 complete instalment 1 on 5 Aug.
      await reverseReceipt(first.id)
      expect(await rows(ids)).toEqual([
        ["PAID", INSTALMENT, AUG_05.toISOString()],
        ["PARTIAL", 20_000, null],
      ])

      await reverseReceipt(second.id)
      expect(await rows(ids)).toEqual([["PARTIAL", 30_000, null], ["PENDING", 0, null]])
    })

    it("on a charges-live loan, leaves the dates to the charges replay", async () => {
      const ids = await createLoan(true)
      const onTime = await capture(ids, INSTALMENT, JUN_29)
      await capture(ids, INSTALMENT, JUL_20)
      await reverseReceipt(onTime.id)
      expect(await rows(ids)).toEqual([
        ["PAID", INSTALMENT, JUL_20.toISOString()],
        ["PENDING", 0, null],
      ])
    })
  })

  describe("a receipt dated before one already on the loan", () => {
    const expected = () => [
      ["PAID", INSTALMENT, JUN_29.toISOString()],
      ["PAID", INSTALMENT, JUL_20.toISOString()],
    ]

    it("manual capture", async () => {
      const ids = await createLoan()
      await capture(ids, INSTALMENT, JUL_20)
      await capture(ids, INSTALMENT, JUN_29)
      expect(await rows(ids)).toEqual(expected())
    })

    it("bank-statement deposit", async () => {
      const ids = await createLoan()
      await capture(ids, INSTALMENT, JUL_20)
      const imp = await db.bankStatementImport.create({
        data: { tenantId: ids.tenantId, source: "ABSA_ONLINE", accountRef: "****1234", format: "CSV", fileHash: randomUUID(), rawFilePath: "x" },
      })
      const txn = await db.bankTransaction.create({
        data: {
          tenantId: ids.tenantId, importId: imp.id, postedDate: JUN_29, valueDate: JUN_29,
          amountCents: INSTALMENT, direction: "CREDIT", dedupHash: randomUUID(), matchStatus: "PROPOSED",
        },
      })
      await applyBankTransaction({ txnId: txn.id, loanId: ids.loanId, tenantId: ids.tenantId, userEmail: "x@test.invalid" })
      expect(await rows(ids)).toEqual(expected())
    })

    it("reconciled held receipt", async () => {
      const ids = await createLoan()
      await capture(ids, INSTALMENT, JUL_20)
      const held = await db.payment.create({
        data: {
          tenantId: ids.tenantId, loanId: ids.loanId, amount: INSTALMENT, receivedAt: JUN_29,
          allocationStatus: "UNAPPLIED", reconciliationReason: "held",
        },
      })
      const response = await reconcile(
        req({ action: "allocate", reason: "Matched to loan", reference: "BANK-1" }),
        { params: Promise.resolve({ id: held.id }) },
      )
      expect(response.status).toBe(200)
      expect(await rows(ids)).toEqual(expected())
    })
  })

  it("re-dates nothing on a loan whose receipts do not add up to its paid instalments, and audits why", async () => {
    const ids = await createLoan()
    // Instalment 1 marked paid on 29 Jun with no receipt behind it (a legacy repair).
    await db.repaymentSchedule.updateMany({
      where: { loanId: ids.loanId, installmentNo: 1 }, data: { totalPaid: INSTALMENT, status: "PAID", paidAt: JUN_29 },
    })
    await db.loan.update({ where: { id: ids.loanId }, data: { totalPaid: INSTALMENT, outstandingPrincipal: INSTALMENT } })

    // Replayed, the only receipt would complete instalment 1 on 20 Jul.
    await capture(ids, INSTALMENT, JUL_20)
    expect(await rows(ids)).toEqual([
      ["PAID", INSTALMENT, JUN_29.toISOString()],
      ["PAID", INSTALMENT, JUL_20.toISOString()],
    ])
    const skipped = await db.auditLog.findMany({ where: { entityId: ids.loanId, action: "SCHEDULE_PAIDAT_RESTAMP_SKIPPED" } })
    expect(skipped.map((row) => [row.userId, row.newValue])).toEqual([[ids.userId, {
      reason: "ledger_identity_broken", source: "manual_capture", loanId: ids.loanId,
      receiptShares: INSTALMENT, schedulePaid: 2 * INSTALMENT, undatableInstalments: [2], mismatchedInstalments: [2],
    }]])
  })

  it("allocates instalments that share a due date in instalment order, as the re-date replays them", async () => {
    const ids = await createLoan()
    // Both due 1 Aug, R600 then R400. Updating instalment 1 last also moves it
    // last on disk, so a due-date-only read returns instalment 2 first.
    await db.repaymentSchedule.updateMany({
      where: { loanId: ids.loanId, installmentNo: 2 }, data: { principalDue: 40_000, totalDue: 40_000 },
    })
    await db.repaymentSchedule.updateMany({
      where: { loanId: ids.loanId, installmentNo: 1 },
      data: { dueDate: new Date("2026-08-01T10:00:00+02:00"), principalDue: 60_000, totalDue: 60_000 },
    })

    await capture(ids, 30_000, JUN_29)
    expect(await rows(ids)).toEqual([["PARTIAL", 30_000, null], ["PENDING", 0, null]])
    expect(await db.auditLog.count({ where: { entityId: ids.loanId, action: "SCHEDULE_PAIDAT_RESTAMP_SKIPPED" } })).toBe(0)
  })

  it("a bulk upload leaves an instalment an earlier receipt paid dated by that receipt", async () => {
    const ids = await createLoan()
    await capture(ids, INSTALMENT, JUN_29)
    const response = await bulkUpload(new NextRequest("http://localhost/api/test", {
      method: "POST", body: JSON.stringify({ rows: [{ reference: ids.reference, amount: INSTALMENT / 100 }] }),
    }))
    expect(await response.json()).toMatchObject({ processed: 1, skipped: 0 })
    expect(await rows(ids)).toEqual([
      ["PAID", INSTALMENT, JUN_29.toISOString()],
      ["PAID", INSTALMENT, NOW.toISOString()],
    ])
  })
})
