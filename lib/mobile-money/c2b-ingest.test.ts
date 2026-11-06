import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"

const { applyManualReceiptInTx, recordHeldReceipt } = vi.hoisted(() => ({
  applyManualReceiptInTx: vi.fn(),
  recordHeldReceipt: vi.fn(),
}))
vi.mock("@/lib/loan/apply-payment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loan/apply-payment")>()),
  applyManualReceiptInTx,
}))
vi.mock("@/lib/payments/held-receipt", () => ({ recordHeldReceipt }))
vi.mock("@/lib/loan/lock", () => ({ lockLoanForUpdate: vi.fn() }))

import { ingestMobileMoneyCallback, type MobileMoneyDb } from "./c2b-ingest"
import { PaymentApplicationError } from "@/lib/loan/apply-payment"
import { ChargesError } from "@/lib/loan/charges-error"
import { simulatedMpesa } from "./providers/simulated"
import type { MobileMoneyCallback } from "./types"

type Row = Record<string, unknown> & { id: string }
const T = "t_ke"
const LOAN = { id: "l1", reference: "NRB-LN-1" }

function fakeDb() {
  const state = { rows: [] as Row[], audits: [] as Array<Record<string, unknown>> }
  const unique = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002", clientVersion: "test", meta: { modelName: "MobileMoneyTransaction", target: ["provider", "transId"] },
  })
  const matches = (where: Record<string, unknown>) => (r: Row) => Object.entries(where).every(([k, v]) => r[k] === v)
  const clash = (provider: unknown, transId: unknown, self?: Row) =>
    transId != null && state.rows.some((r) => r !== self && r.provider === provider && r.transId === transId)
  const db = {
    mobileMoneyTransaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => state.rows.find(matches(where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (clash(data.provider, data.transId)) throw unique()
        const row: Row = { id: `mm${state.rows.length + 1}`, loanId: null, paymentId: null, ...data }
        state.rows.push(row)
        return row
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = state.rows.filter(matches(where))
        if (hit[0] && clash(hit[0].provider, data.transId, hit[0])) throw unique()
        hit.forEach((r) => Object.assign(r, data))
        return { count: hit.length }
      },
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { state.audits.push(data); return data } },
    loan: {
      findMany: async ({ where }: { where: { reference: { equals: string } } }) =>
        [LOAN].filter((l) => l.reference.toLowerCase() === where.reference.equals.toLowerCase()),
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
const ingest = (db: MobileMoneyDb, callback: MobileMoneyCallback) =>
  ingestMobileMoneyCallback(db, { tenantId: T, provider: simulatedMpesa, callback, now: new Date("2026-11-08T09:00:00Z") })

beforeEach(() => {
  applyManualReceiptInTx.mockReset().mockImplementation(async (_tx: unknown, input: { idempotencyKey: string }) => ({
    payment: { id: `pay:${input.idempotencyKey}` }, excessPayment: null, idempotentReplay: false,
  }))
  recordHeldReceipt.mockReset().mockResolvedValue({ id: "held1", allocationStatus: "UNAPPLIED" })
})
afterEach(() => { vi.unstubAllEnvs() })

describe("paybill (C2B) ingest", () => {
  it("books one receipt through applyManualReceipt for a matched account reference", async () => {
    const { db, state } = fakeDb()
    expect(await ingest(db, paybill())).toEqual({ outcome: "BOOKED", transactionId: "mm1", paymentId: "pay:mpesa-c2b:SIM0000001" })
    expect(applyManualReceiptInTx).toHaveBeenCalledTimes(1)
    expect(applyManualReceiptInTx.mock.calls[0][1]).toMatchObject({
      loanId: LOAN.id, tenantId: T, amount: 150_000, paymentMethod: "MOBILE_MONEY", reference: "SIM0000001",
      idempotencyKey: "mpesa-c2b:SIM0000001", valueDateSource: "SYSTEM_OBSERVED", auditUserId: null,
      receivedAt: new Date("2026-11-08T08:59:00Z"),
    })
    expect(applyManualReceiptInTx.mock.calls[0][1].notes).toMatch(/SIMULATED/)
    expect(state.rows[0]).toMatchObject({ status: "BOOKED", loanId: LOAN.id, paymentId: "pay:mpesa-c2b:SIM0000001", msisdnLast4: "5678", simulated: true })
    expect(state.audits.map((a) => a.action)).toEqual(["MOBILE_MONEY_RECEIPT_BOOKED"])
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
    // The other delivery's row lands while this one is booking: the unique key rolls this one back.
    applyManualReceiptInTx.mockImplementationOnce(async () => {
      state.rows.push({ id: "other", provider: "simulated", transId: "SIM0000001", status: "BOOKED" })
      return { payment: { id: "pay-replayed" }, excessPayment: null, idempotentReplay: true }
    })
    expect(await ingest(db, paybill())).toEqual({ outcome: "DUPLICATE" })
  })

  it("stores an unmatched account reference UNMATCHED and books nothing", async () => {
    const { db, state } = fakeDb()
    expect(await ingest(db, paybill({ billRef: "12345678" }))).toEqual({ outcome: "UNMATCHED", transactionId: "mm1" })
    expect(applyManualReceiptInTx).not.toHaveBeenCalled()
    expect(state.rows[0]).toMatchObject({ status: "UNMATCHED", loanId: null, paymentId: null, billRef: "12345678" })
    expect(await ingest(db, paybill({ billRef: "12345678" }))).toEqual({ outcome: "DUPLICATE" })
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
    expect(recordHeldReceipt.mock.calls[0][1]).toMatchObject({ paymentMethod: "MOBILE_MONEY", amount: 150_000, loanId: LOAN.id })
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ status: "HELD", paymentId: "held1" })
  })

  it("puts a receipt the money path refuses (loan not active) in front of a person", async () => {
    const { db, state } = fakeDb()
    applyManualReceiptInTx.mockRejectedValueOnce(new PaymentApplicationError("NOT_ACTIVE", "Loan is not active"))
    expect(await ingest(db, paybill())).toEqual({ outcome: "NEEDS_REVIEW", transactionId: "mm1" })
    expect(state.rows[0]).toMatchObject({ status: "NEEDS_REVIEW", loanId: LOAN.id, paymentId: null })
    expect(String(state.rows[0].reviewReason)).toMatch(/NOT_ACTIVE/)
  })
})

describe("STK push results", () => {
  const pending = (state: ReturnType<typeof fakeDb>["state"]) => state.rows.push({
    id: "stk1", tenantId: T, provider: "simulated", checkoutRequestId: "ws_CO_1", transId: null, status: "PENDING",
    loanId: LOAN.id, billRef: LOAN.reference, amount: 120_000, paymentId: null,
  })
  const paid = (amountCents = 120_000): MobileMoneyCallback => ({
    kind: "STK_PAID", checkoutRequestId: "ws_CO_1", transId: "SIMSTK0001", amountCents, msisdnLast4: "5678", transactedAt: null,
  })

  it("books the pending push once, and a replay books nothing", async () => {
    const { db, state } = fakeDb()
    pending(state)
    expect(await ingest(db, paid())).toEqual({ outcome: "BOOKED", transactionId: "stk1", paymentId: "pay:mpesa-c2b:SIMSTK0001" })
    expect(state.rows[0]).toMatchObject({ status: "BOOKED", transId: "SIMSTK0001" })
    expect(await ingest(db, paid())).toEqual({ outcome: "DUPLICATE" })
    expect(applyManualReceiptInTx).toHaveBeenCalledTimes(1)
  })

  it("records a cancelled push and books nothing", async () => {
    const { db, state } = fakeDb()
    pending(state)
    expect(await ingest(db, { kind: "STK_CANCELLED", checkoutRequestId: "ws_CO_1", reason: "Request cancelled by user" }))
      .toEqual({ outcome: "CANCELLED", transactionId: "stk1" })
    expect(state.rows[0]).toMatchObject({ status: "CANCELLED", paymentId: null })
    expect(applyManualReceiptInTx).not.toHaveBeenCalled()
  })

  it("puts an amount other than the one pushed in front of a person", async () => {
    const { db, state } = fakeDb()
    pending(state)
    expect(await ingest(db, paid(99_000))).toEqual({ outcome: "NEEDS_REVIEW", transactionId: "stk1" })
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
