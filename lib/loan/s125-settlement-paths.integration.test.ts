/**
 * Real-Postgres proof that every receipt writer settles a PASQ v3 instalment
 * loan at its NCA s125 figure, and that the database accepts each one: the
 * Stitch webhook, a bank-statement deposit, a bulk upload, a reconciled held
 * receipt, with default charges live, and a back-dated value date.
 *
 * The rule a stale quote follows: a receipt is priced at its value date. A
 * Stitch receipt's value date is when the client opened the payment request
 * they paid through, if its webhook lands within the hour, so a payment just
 * before midnight settles at the figure shown that day; a later webhook is
 * held for staff to value-date, settling or not. A value date that waives
 * more than may stand unreviewed (an instalment that fell due in between) is
 * held for staff like any other back-dated receipt. A receipt short of the
 * s125 figure at its value date does not settle: the loan stays open on its
 * contract, and what settles it then is the shortfall.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/s125-settlement-paths.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({
    error: null,
    user: { id: ctx.userId, email: "s125-paths-it@test.invalid", role: "SUPER_ADMIN" },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
    await runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
  getDefaultTenantId: async () => ctx.tenantId,
}))
vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

import { prisma } from "@/lib/prisma"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { applyBankTransaction } from "@/lib/bank-sync/apply"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { bookLoan, createApprovedPasqV3Application } from "@/lib/compliance/pasq-v3-application.integration-fixture"
import { settleReceipt } from "@/app/api/portal/payment/webhook/settle-receipt"
import { PATCH as reconcile } from "@/app/api/payments/[id]/reconcile/route"
import { POST as bulkUpload } from "@/app/api/payments/bulk-upload/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const at = (iso: string, time = "10:00") => new Date(`${iso}T${time}:00+02:00`)
const PRICING = {
  principal: 1_000_000, termDays: 180, productType: "PERSONAL" as const, interestRatePm: 0.02,
  interestModel: "REDUCING_BALANCE" as const, initiationFeeModel: "NCA_REG42" as const, initiationFeePct: 0.15,
  initiationFeeMax: 105_000, monthlyServiceFee: 6_900, initiationFeePayment: "DEFERRED" as const,
}

interface Booked { tenantId: string; userId: string; clientId: string; loanId: string; reference: string }

/** A six-instalment loan booked on 24 Jul (instalments due the 24th), instalment 1 paid unless `arrears`. */
async function book(label: string, opts: { chargesLive?: boolean; arrears?: boolean } = {}): Promise<Booked> {
  vi.setSystemTime(at("2026-07-24"))
  const scenario = await createApprovedPasqV3Application(`s125-${label}`, "ACCEPTED", true, "DEFERRED", false, null, { pricing: PRICING })
  if (opts.chargesLive) {
    await db.tenantConfig.create({
      data: { tenantId: scenario.tenantId, defaultChargesEnabled: true, defaultChargesStartedAt: at("2026-01-01") },
    })
  }
  const loanId = await bookLoan(scenario)
  const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
  const booked = { tenantId: scenario.tenantId, userId: scenario.officerId, clientId: scenario.clientId, loanId, reference: loan.reference }
  if (!opts.arrears) await capture(booked, loan.repaymentSchedule[0].totalDue, "2026-08-24")
  return booked
}

async function capture(b: Booked, amount: number, day: string, receivedAt?: Date, overrideReason?: string) {
  vi.setSystemTime(at(day))
  return runWithTenant(b.tenantId, () => applyManualReceipt(prisma, {
    tenantId: b.tenantId, loanId: b.loanId, amount, capturedById: b.userId, receivedAt,
    valueDateOverride: overrideReason ? { reason: overrideReason, approvedById: b.userId, approvedByEmail: null } : null,
  }))
}

/** What settles the loan at `day` (s125, default charges included), as the documents and portal state it. */
async function settlementOn(b: Booked, day: string) {
  const loan = await db.loan.findUniqueOrThrow({
    where: { id: b.loanId }, include: { repaymentSchedule: { orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }] } },
  })
  return (await runWithTenant(b.tenantId, () => loanSettlementFigures(prisma, loan, at(day)))).totalToSettle
}

async function stitchReceipt(b: Booked, amount: number, opened: Date, lands: Date) {
  const stitchId = `stitch-${randomUUID()}`
  const request = await db.stitchPaymentRequest.create({
    data: {
      stitchId, loanId: b.loanId, clientId: b.clientId, amount, externalReference: `ref-${randomUUID()}`,
      redirectUrl: "https://example.invalid/redirect", stitchUrl: "https://example.invalid/pay", createdAt: opened,
    },
    include: { loan: { select: { tenantId: true } } },
  })
  vi.setSystemTime(lands)
  const res = await runWithTenant(b.tenantId, () => settleReceipt(request, stitchId, b.tenantId))
  expect(res.status).toBe(200)
  return db.payment.findFirstOrThrow({ where: { loanId: b.loanId, notes: { contains: stitchId } } })
}

const loanOf = (b: Booked) => db.loan.findUniqueOrThrow({ where: { id: b.loanId } })
const completed = async (b: Booked, closedOn: string | Date) =>
  expect(await loanOf(b)).toMatchObject({ status: "COMPLETED", outstandingPrincipal: 0, closedAt: typeof closedOn === "string" ? at(closedOn) : closedOn })

suite.sequential("s125 settlement through every receipt writer (real Postgres)", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-07-24") })
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  it("Stitch: the figure quoted when the client paid settles, though the webhook lands after midnight", async () => {
    const b = await book("stitch-late")
    const quoted = await settlementOn(b, "2026-09-10")
    const opened = at("2026-09-10", "23:40")
    const payment = await stitchReceipt(b, quoted, opened, at("2026-09-11", "00:20"))
    expect(payment).toMatchObject({ allocationStatus: "ALLOCATED", amount: quoted, receivedAt: opened })
    await completed(b, opened)
  }, 60_000)

  it("Stitch: a webhook over an hour after the request opened is held for staff, settling or not", async () => {
    const b = await book("stitch-stale")
    const quoted = await settlementOn(b, "2026-09-10")
    const before = await loanOf(b)
    const lands = at("2026-09-11")
    for (const amount of [quoted, 10_000]) {
      const payment = await stitchReceipt(b, amount, at("2026-09-10"), lands)
      expect(payment).toMatchObject({ allocationStatus: "UNAPPLIED", reconciliationReason: "stitch_value_date_unconfirmed", receivedAt: lands })
    }
    expect(await loanOf(b)).toMatchObject({ status: "ACTIVE", totalPaid: before.totalPaid })
  }, 60_000)

  it("Stitch: a value date before an instalment fell due is held for staff, who allocate it with a reason", async () => {
    const b = await book("stitch-held")
    const quoted = await settlementOn(b, "2026-09-23")
    const before = await loanOf(b)
    const opened = at("2026-09-23", "23:40")
    const payment = await stitchReceipt(b, quoted, opened, at("2026-09-24", "00:20"))
    expect(payment).toMatchObject({ allocationStatus: "UNAPPLIED", reconciliationReason: "rebate_needs_authorisation", receivedAt: opened })
    expect(await loanOf(b)).toMatchObject({ status: "ACTIVE", totalPaid: before.totalPaid })

    ctx.tenantId = b.tenantId
    ctx.userId = b.userId
    const res = await reconcile(new NextRequest("http://localhost/api/test", {
      method: "PATCH",
      body: JSON.stringify({
        action: "allocate", reason: "Client paid the quoted settlement on 23 September", reference: "STITCH",
        valueDateOverrideReason: "Stitch confirmed the client paid at 23:40 on 23 September; webhook after midnight.",
      }),
    }), { params: Promise.resolve({ id: payment.id }) })
    expect(res.status).toBe(200)
    await completed(b, opened)
  }, 60_000)

  it("a stale quote paid a day late does not settle: the loan stays open owing the shortfall", async () => {
    const b = await book("stale")
    const quoted = await settlementOn(b, "2026-09-10")
    await capture(b, quoted, "2026-09-11")
    expect(await loanOf(b)).toMatchObject({ status: "ACTIVE" })
    const shortfall = await settlementOn(b, "2026-09-11")
    // One more day of instalment 2's interest (24 Aug – 24 Sep, 31 days).
    expect(shortfall).toBeGreaterThan(0)
    expect(shortfall).toBeLessThan(10_000)
    await capture(b, shortfall, "2026-09-11")
    await completed(b, "2026-09-11")
  }, 60_000)

  it("a bank-statement deposit settles at its value date", async () => {
    const b = await book("bank")
    const due = await settlementOn(b, "2026-09-10")
    vi.setSystemTime(at("2026-09-12"))
    const imp = await db.bankStatementImport.create({
      data: { tenantId: b.tenantId, source: "ABSA_ONLINE", accountRef: "****1234", format: "CSV", fileHash: randomUUID(), rawFilePath: "x" },
    })
    const txn = await db.bankTransaction.create({
      data: {
        tenantId: b.tenantId, importId: imp.id, postedDate: at("2026-09-10"), valueDate: at("2026-09-10"),
        amountCents: due, direction: "CREDIT", dedupHash: randomUUID(), matchStatus: "PROPOSED",
      },
    })
    await runWithTenant(b.tenantId, () => applyBankTransaction({ txnId: txn.id, loanId: b.loanId, tenantId: b.tenantId, userEmail: "x@test.invalid" }))
    await completed(b, "2026-09-10")
  }, 60_000)

  it("a bulk upload settles at the s125 figure", async () => {
    const b = await book("bulk")
    const due = await settlementOn(b, "2026-09-10")
    ctx.tenantId = b.tenantId
    ctx.userId = b.userId
    vi.setSystemTime(at("2026-09-10"))
    const res = await bulkUpload(new NextRequest("http://localhost/api/test", {
      method: "POST", body: JSON.stringify({ rows: [{ reference: b.reference, amount: due / 100 }] }),
    }))
    expect(await res.json()).toMatchObject({ processed: 1, skipped: 0 })
    await completed(b, "2026-09-10")
  }, 60_000)

  it("with default charges live, the s125 figure plus the charges settles", async () => {
    const b = await book("charges", { chargesLive: true, arrears: true })
    const due = await settlementOn(b, "2026-09-10")
    const { payment } = await capture(b, due, "2026-09-10")
    const booked = await db.payment.findUniqueOrThrow({ where: { id: payment.id } })
    expect(booked.defaultInterestAllocated + booked.chargeFeesAllocated).toBeGreaterThan(0)
    await completed(b, "2026-09-10")
  }, 60_000)

  it("a value date back across a due date needs a reason, and then settles at that date", async () => {
    const b = await book("backdated")
    const due = await settlementOn(b, "2026-09-23")
    await expect(capture(b, due, "2026-09-25", at("2026-09-23"))).rejects.toThrow(/writes off more interest than may be approved unreviewed/)
    expect(await loanOf(b)).toMatchObject({ status: "ACTIVE" })
    await capture(b, due, "2026-09-25", at("2026-09-23"), "Client's EFT cleared on 23 September; bank statement confirms.")
    await completed(b, "2026-09-23")
  }, 60_000)
})
