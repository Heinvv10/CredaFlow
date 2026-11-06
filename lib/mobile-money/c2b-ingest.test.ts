import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"

const { applyManualReceiptInTx, recordHeldReceipt, triggerNotification } = vi.hoisted(() => ({
  applyManualReceiptInTx: vi.fn(),
  recordHeldReceipt: vi.fn(),
  triggerNotification: vi.fn(async () => undefined),
}))
vi.mock("@/lib/loan/apply-payment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loan/apply-payment")>()),
  applyManualReceiptInTx,
}))
vi.mock("@/lib/payments/held-receipt", () => ({ recordHeldReceipt }))
vi.mock("@/lib/loan/lock", () => ({ lockLoanForUpdate: vi.fn() }))
vi.mock("@/lib/notifications", () => ({ triggerNotification }))

import { ingestMobileMoneyCallback, type MobileMoneyDb } from "./c2b-ingest"
import { valueDate } from "./book"
import { PaymentApplicationError } from "@/lib/loan/apply-payment"
import { ChargesError } from "@/lib/loan/charges-error"
import { simulatedMpesa } from "./providers/simulated"
import type { MobileMoneyCallback } from "./types"

type Row = Record<string, unknown> & { id: string }
const T = "t_ke"
const LOANS = [{ id: "l1", tenantId: T, reference: "NRB-LN-1" }]
const NOW = new Date("2026-11-08T09:00:00Z")

function fakeDb() {
  const state = { rows: [] as Row[], audits: [] as Array<Record<string, unknown>> }
  const unique = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002", clientVersion: "test", meta: { modelName: "MobileMoneyTransaction", target: ["tenantId", "provider", "transId"] },
  })
  const matches = (where: Record<string, unknown>) => (r: Row) => Object.entries(where).every(([k, v]) => r[k] === v)
  const clash = (tenantId: unknown, provider: unknown, transId: unknown, self?: Row) =>
    transId != null && state.rows.some((r) => r !== self && r.tenantId === tenantId && r.provider === provider && r.transId === transId)
  const db = {
    mobileMoneyTransaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => state.rows.find(matches(where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (clash(data.tenantId, data.provider, data.transId)) throw unique()
        const row: Row = { id: `mm${state.rows.length + 1}`, loanId: null, paymentId: null, ...data }
        state.rows.push(row)
        return row
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = state.rows.filter(matches(where))
        if (hit[0] && clash(hit[0].tenantId, hit[0].provider, data.transId, hit[0])) throw unique()
        hit.forEach((r) => Object.assign(r, data))
        return { count: hit.length }
      },
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { state.audits.push(data); return data } },
    // The exact, case-folded reference match (lower() = lower(), never LIKE).
    $queryRaw: async (sql: Prisma.Sql) => {
      const [tenantId, reference] = sql.values
      return LOANS.filter((l) => l.tenantId === tenantId && l.reference.toLowerCase() === String(reference).toLowerCase()).map((l) => ({ id: l.id }))
    },
    // Rolls the fake back on a throw, as Postgres does.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = { rows: state.rows.map((r) => ({ ...r })), audits: state.audits.length }
      try {
        return await fn(db)
      } catch (error) {
        state.rows = snapshot.rows
        state.audits.length = snapshot.audits
        throw error
      }
    },
  }
  return { db: db as unknown as MobileMoneyDb, state }
}

const paybill = (over: Partial<Extract<MobileMoneyCallback, { kind: "C2B" }>> = {}): MobileMoneyCallback => ({
  kind: "C2B", transId: "SIM0000001", billRef: " nrb-ln-1 ", amountCents: 150_000, msisdnLast4: "5678",
  transactedAt: new Date("2026-11-08T08:59:00Z"), ...over,
})
const ingest = (db: MobileMoneyDb, callback: MobileMoneyCallback, tenantId = T) =>
  ingestMobileMoneyCallback(db, { tenantId, provider: simulatedMpesa, callback, now: NOW })

beforeEach(() => {
  applyManualReceiptInTx.mockReset().mockImplementation(async (_tx: unknown, input: { idempotencyKey: string; amount: number }) => ({
    payment: { id: `pay:${input.idempotencyKey}`, amount: input.amount, allocationStatus: "ALLOCATED" }, excessPayment: null, idempotentReplay: false,
  }))
  recordHeldReceipt.mockReset().mockResolvedValue({ id: "held1", allocationStatus: "UNAPPLIED" })
  triggerNotification.mockClear()
})
afterEach(() => { vi.unstubAllEnvs() })

describe("paybill (C2B) ingest", () => {
  it("books one receipt through applyManualReceipt for a matched account reference, and tells the client", async () => {
    const { db, state } = fakeDb()
    expect(await ingest(db, paybill())).toEqual({ outcome: "BOOKED", transactionId: "mm1", paymentId: "pay:mpesa-c2b:SIM0000001" })
    expect(applyManualReceiptInTx).toHaveBeenCalledTimes(1)
    expect(applyManualReceiptInTx.mock.calls[0][1]).toMatchObject({
      loanId: "l1", tenantId: T, amount: 150_000, paymentMethod: "MOBILE_MONEY", reference: "SIM0000001",
      idempotencyKey: "mpesa-c2b:SIM0000001", valueDateSource: "SYSTEM_OBSERVED", auditUserId: null,
      receivedAt: new Date("2026-11-08T08:59:00Z"),
    })
    expect(applyManualReceiptInTx.mock.calls[0][1].notes).toMatch(/SIMULATED/)
    expect(state.rows[0]).toMatchObject({ status: "BOOKED", loanId: "l1", paymentId: "pay:mpesa-c2b:SIM0000001", msisdnLast4: "5678", simulated: true })
    expect(state.audits.map((a) => a.action)).toEqual(["MOBILE_MONEY_RECEIPT_BOOKED"])
    expect(triggerNotification).toHaveBeenCalledTimes(1)
    expect(triggerNotification).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: T, event: "payment_received", loanId: "l1", data: { amount: 150_000, paymentId: "pay:mpesa-c2b:SIM0000001" },
    }))
  })

  it("does not tell the client when the receipt is not allocated (refund-due, or held)", async () => {
    const { db } = fakeDb()
    applyManualReceiptInTx.mockResolvedValueOnce({ payment: { id: "p-un", amount: 1, allocationStatus: "UNAPPLIED" }, excessPayment: null, idempotentReplay: false })
    expect(await ingest(db, paybill())).toMatchObject({ outcome: "BOOKED" })
    applyManualReceiptInTx.mockRejectedValueOnce(new ChargesError("charges cannot be booked"))
    expect(await ingest(db, paybill({ transId: "SIM0000002" }))).toMatchObject({ outcome: "HELD" })
    expect(triggerNotification).not.toHaveBeenCalled()
  })

  it("books nothing for a replayed TransID", async () => {
    const { db, state } = fakeDb()
    await ingest(db, paybill())
    expect(await ingest(db, paybill())).toEqual({ outcome: "DUPLICATE" })
    expect(applyManualReceiptInTx).toHaveBeenCalledTimes(1)
    expect(state.rows).toHaveLength(1)
  })

  it("books nothing when a concurrent delivery of the same TransID commits first", async () => {
    const { db, state } = fakeDb()
    applyManualReceiptInTx.mockImplementationOnce(async () => {
      state.rows.push({ id: "other", tenantId: T, provider: "simulated", transId: "SIM0000001", status: "BOOKED" })
      return { payment: { id: "pay-replayed", allocationStatus: "ALLOCATED" }, excessPayment: null, idempotentReplay: true }
    })
    expect(await ingest(db, paybill())).toEqual({ outcome: "DUPLICATE" })
    expect(triggerNotification).not.toHaveBeenCalled()
  })

  it("is not a replay when another lender holds the same TransID", async () => {
    const { db, state } = fakeDb()
    state.rows.push({ id: "elsewhere", tenantId: "t_other", provider: "simulated", transId: "SIM0000001", status: "BOOKED" })
    expect(await ingest(db, paybill())).toMatchObject({ outcome: "BOOKED" })
  })

  it("stores an unmatched account reference UNMATCHED and books nothing", async () => {
    const { db, state } = fakeDb()
    expect(await ingest(db, paybill({ billRef: "12345678" }))).toEqual({ outcome: "UNMATCHED", transactionId: "mm1" })
    expect(applyManualReceiptInTx).not.toHaveBeenCalled()
    expect(state.rows[0]).toMatchObject({ status: "UNMATCHED", loanId: null, paymentId: null, billRef: "12345678" })
    expect(await ingest(db, paybill({ billRef: "12345678" }))).toEqual({ outcome: "DUPLICATE" })
  })

  it("matches only the lender's own loans", async () => {
    const { db, state } = fakeDb()
    expect(await ingest(db, paybill(), "t_other")).toMatchObject({ outcome: "UNMATCHED" })
    expect(state.rows[0]).toMatchObject({ tenantId: "t_other", loanId: null })
    expect(applyManualReceiptInTx).not.toHaveBeenCalled()
  })

  it("puts a simulated callback in front of a person where simulation is forbidden, booking nothing", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const { db, state } = fakeDb()
    expect(await ingest(db, paybill())).toEqual({ outcome: "NEEDS_REVIEW", transactionId: "mm1" })
    expect(applyManualReceiptInTx).not.toHaveBeenCalled()
    expect(state.rows[0]).toMatchObject({ status: "NEEDS_REVIEW", paymentId: null })
    expect(String(state.rows[0].reviewReason)).toMatch(/simulation/)
  })

  it("holds the money UNAPPLIED when the charges replay refuses it", async () => {
    const { db, state } = fakeDb()
    applyManualReceiptInTx.mockRejectedValueOnce(new ChargesError("charges cannot be booked"))
    expect(await ingest(db, paybill())).toEqual({ outcome: "HELD", transactionId: "mm1", paymentId: "held1" })
    expect(recordHeldReceipt.mock.calls[0][1]).toMatchObject({ paymentMethod: "MOBILE_MONEY", amount: 150_000, loanId: "l1" })
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ status: "HELD", paymentId: "held1" })
  })

  it("puts a receipt the money path refuses (loan not active) in front of a person", async () => {
    const { db, state } = fakeDb()
    applyManualReceiptInTx.mockRejectedValueOnce(new PaymentApplicationError("NOT_ACTIVE", "Loan is not active"))
    expect(await ingest(db, paybill())).toEqual({ outcome: "NEEDS_REVIEW", transactionId: "mm1" })
    expect(state.rows[0]).toMatchObject({ status: "NEEDS_REVIEW", loanId: "l1", paymentId: null })
    expect(String(state.rows[0].reviewReason)).toMatch(/NOT_ACTIVE/)
  })

  it("dates the receipt when the provider says the money moved, never later than now", async () => {
    expect(valueDate(new Date("2026-11-08T08:00:00Z"), NOW)).toEqual(new Date("2026-11-08T08:00:00Z"))
    expect(valueDate(new Date("2026-11-09T08:00:00Z"), NOW)).toEqual(NOW)
    expect(valueDate(null, NOW)).toEqual(NOW)
    const { db } = fakeDb()
    await ingest(db, paybill({ transactedAt: new Date("2027-01-01T00:00:00Z") }))
    expect(applyManualReceiptInTx.mock.calls[0][1].receivedAt).toEqual(NOW)
  })
})

describe("STK push results", () => {
  const pending = (state: ReturnType<typeof fakeDb>["state"], status = "PENDING") => state.rows.push({
    id: "stk1", tenantId: T, provider: "simulated", checkoutRequestId: "ws_CO_1", transId: null, status,
    loanId: "l1", billRef: "NRB-LN-1", amount: 120_000, paymentId: null,
  })
  const paid = (over: { amountCents?: number; transId?: string } = {}): MobileMoneyCallback => ({
    kind: "STK_PAID", checkoutRequestId: "ws_CO_1", transId: over.transId ?? "SIMSTK0001", amountCents: over.amountCents ?? 120_000,
    msisdnLast4: "5678", transactedAt: null,
  })

  it("books the pending push once, and a replay books nothing", async () => {
    const { db, state } = fakeDb()
    pending(state)
    expect(await ingest(db, paid())).toEqual({ outcome: "BOOKED", transactionId: "stk1", paymentId: "pay:mpesa-c2b:SIMSTK0001" })
    expect(state.rows[0]).toMatchObject({ status: "BOOKED", transId: "SIMSTK0001" })
    expect(await ingest(db, paid())).toEqual({ outcome: "DUPLICATE" })
    expect(applyManualReceiptInTx).toHaveBeenCalledTimes(1)
  })

  it("books nothing when a concurrent delivery settles the push first (the conditional claim)", async () => {
    const { db, state } = fakeDb()
    pending(state)
    applyManualReceiptInTx.mockImplementationOnce(async () => {
      state.rows[0].status = "BOOKED"
      return { payment: { id: "pay-x", allocationStatus: "ALLOCATED" }, excessPayment: null, idempotentReplay: true }
    })
    expect(await ingest(db, paid())).toEqual({ outcome: "DUPLICATE" })
    expect(triggerNotification).not.toHaveBeenCalled()
  })

  it("records a cancelled push and books nothing", async () => {
    const { db, state } = fakeDb()
    pending(state)
    expect(await ingest(db, { kind: "STK_CANCELLED", checkoutRequestId: "ws_CO_1", reason: "Request cancelled by user" }))
      .toEqual({ outcome: "CANCELLED", transactionId: "stk1" })
    expect(state.rows[0]).toMatchObject({ status: "CANCELLED", paymentId: null })
    expect(applyManualReceiptInTx).not.toHaveBeenCalled()
  })

  it("keeps money paid after the push was recorded cancelled, for a person, instead of calling it a replay", async () => {
    const { db, state } = fakeDb()
    pending(state, "CANCELLED")
    const out = await ingest(db, paid({ transId: "SIMLATE001" }))
    expect(out).toMatchObject({ outcome: "NEEDS_REVIEW" })
    const late = state.rows.find((r) => r.transId === "SIMLATE001")
    expect(late).toMatchObject({ status: "NEEDS_REVIEW", loanId: "l1", amount: 120_000, checkoutRequestId: null, paymentId: null })
    expect(state.rows[0]).toMatchObject({ status: "CANCELLED" })
    expect(applyManualReceiptInTx).not.toHaveBeenCalled()
    // Its own replay is a replay.
    expect(await ingest(db, paid({ transId: "SIMLATE001" }))).toEqual({ outcome: "DUPLICATE" })
  })

  it("a settled push's own transaction delivered again is a replay", async () => {
    const { db, state } = fakeDb()
    pending(state)
    await ingest(db, paid())
    expect(await ingest(db, paid())).toEqual({ outcome: "DUPLICATE" })
    expect(state.rows).toHaveLength(1)
  })

  it("puts an STK result from a simulating provider in front of a person where simulation is forbidden", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const { db, state } = fakeDb()
    pending(state)
    expect(await ingest(db, paid())).toEqual({ outcome: "NEEDS_REVIEW", transactionId: "stk1" })
    expect(state.rows[0]).toMatchObject({ status: "NEEDS_REVIEW", transId: "SIMSTK0001", paymentId: null })
    expect(state.rows[0].reportedAmount).toBeUndefined()
    expect(applyManualReceiptInTx).not.toHaveBeenCalled()
  })

  it("records the reported amount even when a forbidden simulated result also differs from the push", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const { db, state } = fakeDb()
    pending(state)
    expect(await ingest(db, paid({ amountCents: 99_000 }))).toMatchObject({ outcome: "NEEDS_REVIEW" })
    expect(state.rows[0]).toMatchObject({ status: "NEEDS_REVIEW", amount: 120_000, reportedAmount: 99_000 })
    expect(String(state.rows[0].reviewReason)).toMatch(/simulation/)
  })

  it("puts an amount other than the one pushed in front of a person", async () => {
    const { db, state } = fakeDb()
    pending(state)
    expect(await ingest(db, paid({ amountCents: 99_000 }))).toEqual({ outcome: "NEEDS_REVIEW", transactionId: "stk1" })
    expect(applyManualReceiptInTx).not.toHaveBeenCalled()
    // The row keeps what was pushed AND what the provider says was paid: staff book the latter.
    expect(state.rows[0]).toMatchObject({ status: "NEEDS_REVIEW", amount: 120_000, reportedAmount: 99_000 })
    expect(state.audits.at(-1)?.newValue).toMatchObject({ amount: 120_000, reportedAmount: 99_000 })
  })

  it("finds only the lender's own push", async () => {
    const { db, state } = fakeDb()
    pending(state)
    expect(await ingest(db, paid(), "t_other")).toMatchObject({ outcome: "UNMATCHED" })
    expect(state.rows[0]).toMatchObject({ status: "PENDING", transId: null })
    expect(applyManualReceiptInTx).not.toHaveBeenCalled()
  })

  it("keeps a paid result for a push it never saw as UNMATCHED, and ignores an unknown cancellation", async () => {
    const { db, state } = fakeDb()
    expect(await ingest(db, paid())).toEqual({ outcome: "UNMATCHED", transactionId: "mm1" })
    expect(state.rows[0]).toMatchObject({ status: "UNMATCHED", transId: "SIMSTK0001", loanId: null })
    expect(await ingest(db, { kind: "STK_CANCELLED", checkoutRequestId: "ws_CO_9", reason: "x" })).toEqual({ outcome: "UNKNOWN_REQUEST" })
    expect(applyManualReceiptInTx).not.toHaveBeenCalled()
  })
})
