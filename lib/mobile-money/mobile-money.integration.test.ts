/**
 * M-Pesa receipts against a migrated PostgreSQL, on a Kenyan instance
 * (migrations 20261108110000_payment_method_mobile_money and
 * 20261108110100_mobile_money_transactions): a paybill payment books exactly
 * one MOBILE_MONEY receipt through applyManualReceipt; a replay or racing
 * delivery books nothing; an unknown, wildcard or another lender's account
 * reference books nothing; another lender's TransID is not a replay; an STK
 * push settles from its simulated callback, and a late payment on a settled
 * push is kept, not dropped. Includes the KE-4 breaker's repro cases.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/mobile-money/mobile-money.integration.test.ts
 *
 * The role needs CREATEDB (a throwaway KE database).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ingestMobileMoneyCallback } from "./c2b-ingest"
import { simulatedC2BPayment, simulatedMpesa } from "./providers/simulated"
import { startStkPush } from "./stk-push"
import { registerMobileMoneyProvider } from "./registry"
import type { MobileMoneyProvider } from "./types"
import { createMobileMoneyFixture, IT_SECRET, PHONE, type MobileMoneyFixture } from "./mobile-money.integration-fixture"

vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip

/** A provider whose push is accepted after a pause and answered later: the claim stays PENDING. */
const slowPush: MobileMoneyProvider = {
  id: "it-slow-push", displayName: "IT slow push", signatureHeader: "x-none", simulation: () => null,
  requestStkPush: async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return { kind: "accepted", checkoutRequestId: `ws_CO_IT_${Math.random().toString(36).slice(2)}` }
  },
  parseCallback: () => null,
}
registerMobileMoneyProvider(slowPush)

suite("M-Pesa receipts on a Kenyan instance (real DB)", () => {
  let f: MobileMoneyFixture
  const rows = (where: Record<string, unknown>) => f.fresh.db.mobileMoneyTransaction.findMany({ where })
  const pending = (tenantId: string, loanId: string, reference: string, checkoutRequestId: string, amount = 20_000) =>
    f.fresh.db.mobileMoneyTransaction.create({ data: { tenantId, provider: "simulated", checkoutRequestId, billRef: reference, amount, status: "PENDING", loanId, simulated: true } })
  const stkPaid = (tenantId: string, checkoutRequestId: string, transId: string, amount = "200.00") =>
    f.signed(tenantId, { type: "STK", checkoutRequestId, result: "PAID", transId, amount, msisdn: PHONE })

  beforeAll(async () => {
    vi.stubEnv("SIMULATED_MPESA_WEBHOOK_SECRET", IT_SECRET)
    f = await createMobileMoneyFixture()
  }, 240_000)
  afterEach(() => { vi.stubEnv("NODE_ENV", "test") })
  afterAll(async () => { vi.unstubAllEnvs(); await f?.fresh.drop() })

  it("seeds Kenyan lenders billed in shillings", async () => {
    expect(await f.fresh.db.tenantConfig.findUniqueOrThrow({ where: { tenantId: f.A.tenantId } })).toMatchObject({ jurisdiction: "KE", currency: "KES" })
  })

  it("books a paybill payment quoting the loan reference once, as a MOBILE_MONEY receipt with its audit", async () => {
    const out = await f.deliver(f.A.tenantId, simulatedC2BPayment({ tenantId: f.A.tenantId, transId: "SIMIT00001", billRef: ` ${f.A.reference.toLowerCase()} `, amountCents: 50_000, msisdn: PHONE }))
    expect(out).toMatchObject({ outcome: "BOOKED" })
    const payment = await f.fresh.db.payment.findFirstOrThrow({ where: { loanId: f.A.loanId } })
    expect(payment).toMatchObject({ amount: 50_000, paymentMethod: "MOBILE_MONEY", reference: "SIMIT00001", idempotencyKey: "mpesa-c2b:SIMIT00001", allocationStatus: "ALLOCATED" })
    const [row] = await rows({ transId: "SIMIT00001" })
    expect(row).toMatchObject({ status: "BOOKED", loanId: f.A.loanId, paymentId: payment.id, msisdnLast4: "5678", simulated: true })
    const recorded = await f.fresh.db.auditLog.findFirstOrThrow({ where: { tenantId: f.A.tenantId, action: "PAYMENT_RECORDED", entityId: f.A.loanId } })
    expect(recorded.newValue).toMatchObject({ method: "MOBILE_MONEY", source: "SYSTEM_OBSERVED" })
    const audits = await f.fresh.db.auditLog.findMany({ where: { entityId: row.id } })
    expect(audits.map((a) => a.action)).toEqual(["MOBILE_MONEY_RECEIPT_BOOKED"])
    expect(JSON.stringify([row, audits])).not.toContain(PHONE)
  })

  it("books nothing for a replayed TransID", async () => {
    const before = await f.payments(f.A.loanId)
    expect(await f.deliver(f.A.tenantId, f.paybill(f.A.tenantId, "SIMIT00001", f.A.reference))).toEqual({ outcome: "DUPLICATE" })
    expect(await f.payments(f.A.loanId)).toBe(before)
  })

  it("books one receipt when five deliveries of a new TransID race (breaker 6)", async () => {
    const before = await f.payments(f.A.loanId)
    const outs = await Promise.all([1, 2, 3, 4, 5].map(() => f.deliver(f.A.tenantId, f.paybill(f.A.tenantId, "SIMRACE001", f.A.reference, "10.00"))))
    expect(outs.map((o) => o.outcome).sort()).toEqual(["BOOKED", "DUPLICATE", "DUPLICATE", "DUPLICATE", "DUPLICATE"])
    expect(await f.payments(f.A.loanId)).toBe(before + 1)
  })

  it("stores an unknown account reference UNMATCHED and books nothing", async () => {
    const before = await f.payments(f.A.loanId)
    expect(await f.deliver(f.A.tenantId, f.paybill(f.A.tenantId, "SIMIT00003", "NO-SUCH-LOAN"))).toMatchObject({ outcome: "UNMATCHED" })
    expect(await f.payments(f.A.loanId)).toBe(before)
    expect((await rows({ transId: "SIMIT00003" }))[0]).toMatchObject({ status: "UNMATCHED", loanId: null, paymentId: null, billRef: "NO-SUCH-LOAN" })
  })

  it("a _ or % in the account number matches no other loan (breaker 2: no LIKE semantics)", async () => {
    const before = await f.payments(f.A.loanId)
    for (const [i, wild] of [f.A.reference.slice(0, -1) + "_", f.A.reference.slice(0, 4) + "%"].entries()) {
      expect(await f.deliver(f.A.tenantId, f.paybill(f.A.tenantId, `SIMWILD00${i}`, wild)), wild).toMatchObject({ outcome: "UNMATCHED" })
    }
    expect(await f.payments(f.A.loanId)).toBe(before)
  })

  it("matches only the receiving lender's loans: B quoting A's reference books nothing on A", async () => {
    const before = await f.payments(f.A.loanId)
    expect(await f.deliver(f.B.tenantId, f.paybill(f.B.tenantId, "SIMXREF001", f.A.reference))).toMatchObject({ outcome: "UNMATCHED" })
    expect(await f.payments(f.A.loanId)).toBe(before)
    expect((await rows({ transId: "SIMXREF001" }))[0]).toMatchObject({ tenantId: f.B.tenantId, loanId: null })
  })

  it("another lender's TransID is not a replay (breaker 3)", async () => {
    await f.deliver(f.A.tenantId, f.paybill(f.A.tenantId, "SIMXT0001", f.A.reference, "100.00"))
    expect(await f.deliver(f.B.tenantId, f.paybill(f.B.tenantId, "SIMXT0001", f.B.reference, "100.00"))).toMatchObject({ outcome: "BOOKED" })
    expect(await f.payments(f.B.loanId)).toBe(1)
  })

  it("refuses an amount a cents column cannot hold before anything is stored (breaker 4)", async () => {
    expect(simulatedMpesa.parseCallback({ ...f.paybill(f.A.tenantId, "SIMBIG0001", f.A.reference, "30000000.00"), tenantId: f.A.tenantId })).toBeNull()
    expect(await rows({ transId: "SIMBIG0001" })).toEqual([])
  })

  it("keeps a payment on a closed loan NEEDS_REVIEW (breaker 5)", async () => {
    const closed = await f.loan()
    await f.fresh.db.loan.update({ where: { id: closed.loanId }, data: { status: "COMPLETED" } })
    expect(await f.deliver(f.A.tenantId, f.paybill(f.A.tenantId, "SIMCLOSED1", closed.reference))).toMatchObject({ outcome: "NEEDS_REVIEW" })
    expect((await rows({ transId: "SIMCLOSED1" }))[0]).toMatchObject({ status: "NEEDS_REVIEW", loanId: closed.loanId, paymentId: null })
  })

  it("books nothing from a simulated paybill callback where simulation is not permitted", async () => {
    const callback = simulatedMpesa.parseCallback({ ...f.paybill(f.A.tenantId, "SIMIT00004", f.A.reference), tenantId: f.A.tenantId })
    if (!callback) throw new Error("did not verify")
    vi.stubEnv("NODE_ENV", "production")
    const before = await f.payments(f.A.loanId)
    expect(await ingestMobileMoneyCallback(f.db, { tenantId: f.A.tenantId, provider: simulatedMpesa, callback })).toMatchObject({ outcome: "NEEDS_REVIEW" })
    expect(await f.payments(f.A.loanId)).toBe(before)
  })

  it("settles an STK push from its simulated callback: paid books once, 0000 is cancelled", async () => {
    const loan = await f.loan()
    const push = (phone: string) => startStkPush(f.db, {
      tenantId: f.A.tenantId, providerId: "simulated", loan: { id: loan.loanId, reference: loan.reference },
      amountCents: 20_000, phone, actorEmail: "borrower@test.invalid",
    })
    const paid = await push("0712 345 678")
    expect(paid).toMatchObject({ ok: true, status: "BOOKED" })
    if (!paid.ok) return
    const row = await f.fresh.db.mobileMoneyTransaction.findUniqueOrThrow({ where: { id: paid.transactionId } })
    expect(row).toMatchObject({ status: "BOOKED", billRef: loan.reference, amount: 20_000, msisdnLast4: "5678" })
    expect(row.checkoutRequestId).toMatch(/^ws_CO_SIM_/)
    expect(await f.payments(loan.loanId)).toBe(1)
    expect((await f.fresh.db.auditLog.findMany({ where: { entityId: row.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action))
      .toEqual(["MOBILE_MONEY_STK_REQUESTED", "MOBILE_MONEY_RECEIPT_BOOKED"])
    expect(await push("0712 340 000")).toMatchObject({ ok: true, status: "CANCELLED" })
    expect(await f.payments(loan.loanId)).toBe(1)
  })

  it("keeps money paid after the push was recorded cancelled, instead of calling it a replay (breaker 1)", async () => {
    const co = "ws_CO_SIM_late0001"
    await pending(f.A.tenantId, f.A.loanId, f.A.reference, co)
    expect(await f.deliver(f.A.tenantId, f.signed(f.A.tenantId, { type: "STK", checkoutRequestId: co, result: "CANCELLED", reason: "timeout" }))).toMatchObject({ outcome: "CANCELLED" })
    const out = await f.deliver(f.A.tenantId, stkPaid(f.A.tenantId, co, "SIMLATE001"))
    expect(out.outcome).toBe("NEEDS_REVIEW")
    expect(await rows({ transId: "SIMLATE001" })).toEqual([expect.objectContaining({ status: "NEEDS_REVIEW", loanId: f.A.loanId, amount: 20_000 })])
    expect(await f.deliver(f.A.tenantId, stkPaid(f.A.tenantId, co, "SIMLATE001"))).toEqual({ outcome: "DUPLICATE" })
  })

  it("books one receipt when two deliveries of one STK result race", async () => {
    const loan = await f.loan()
    await pending(f.A.tenantId, loan.loanId, loan.reference, "ws_CO_SIM_race0001")
    const outs = await Promise.all([1, 2].map(() => f.deliver(f.A.tenantId, stkPaid(f.A.tenantId, "ws_CO_SIM_race0001", "SIMSTKR001"))))
    expect(outs.map((o) => o.outcome).sort()).toEqual(["BOOKED", "DUPLICATE"])
    expect(await f.payments(loan.loanId)).toBe(1)
  })

  it("books one receipt when a paybill confirmation and an STK result carry one TransID (breaker 7)", async () => {
    const loan = await f.loan()
    await pending(f.A.tenantId, loan.loanId, loan.reference, "ws_CO_SIM_both0001", 5_000)
    await Promise.all([
      f.deliver(f.A.tenantId, f.paybill(f.A.tenantId, "SIMBOTH001", loan.reference, "50.00")),
      f.deliver(f.A.tenantId, stkPaid(f.A.tenantId, "ws_CO_SIM_both0001", "SIMBOTH001", "50.00")),
    ])
    expect(await f.payments(loan.loanId)).toBe(1)
  })

  it("books nothing from a simulated STK result where simulation is not permitted", async () => {
    const loan = await f.loan()
    await pending(f.A.tenantId, loan.loanId, loan.reference, "ws_CO_SIM_forb0001")
    const callback = simulatedMpesa.parseCallback({ ...stkPaid(f.A.tenantId, "ws_CO_SIM_forb0001", "SIMFORB001"), tenantId: f.A.tenantId })
    if (!callback) throw new Error("did not verify")
    vi.stubEnv("NODE_ENV", "production")
    expect(await ingestMobileMoneyCallback(f.db, { tenantId: f.A.tenantId, provider: simulatedMpesa, callback })).toMatchObject({ outcome: "NEEDS_REVIEW" })
    expect(await f.payments(loan.loanId)).toBe(0)
  })

  it("finds only the receiving lender's push: B's result for A's checkout id leaves A's push PENDING", async () => {
    const push = await pending(f.A.tenantId, f.A.loanId, f.A.reference, "ws_CO_SIM_xten0001")
    expect(await f.deliver(f.B.tenantId, stkPaid(f.B.tenantId, "ws_CO_SIM_xten0001", "SIMXTSTK01"))).toMatchObject({ outcome: "UNMATCHED" })
    expect(await f.fresh.db.mobileMoneyTransaction.findUniqueOrThrow({ where: { id: push.id } })).toMatchObject({ status: "PENDING", transId: null })
  })

  it("claims at most one open push per loan when two pushes race (the loan lock)", async () => {
    const loan = await f.loan()
    const push = () => startStkPush(f.db, {
      tenantId: f.A.tenantId, providerId: slowPush.id, loan: { id: loan.loanId, reference: loan.reference },
      amountCents: 10_000, phone: "0712 345 678", actorEmail: "borrower@test.invalid",
    })
    const outs = await Promise.all([push(), push(), push()])
    expect(outs.filter((o) => o.ok)).toHaveLength(1)
    expect(outs.filter((o) => !o.ok).map((o) => !o.ok && o.reason)).toEqual(["PUSH_PENDING", "PUSH_PENDING"])
    expect(await f.fresh.db.mobileMoneyTransaction.count({ where: { loanId: loan.loanId, status: "PENDING" } })).toBe(1)
  })

  it("no other lender's push can block a loan: the composite tenant key refuses one naming it", async () => {
    // Why the open-push lookup's tenant filter cannot change behaviour: a push is
    // bound to (tenantId, loanId), so another lender's row can never name this loan.
    await expect(f.fresh.db.mobileMoneyTransaction.create({
      data: { tenantId: f.B.tenantId, provider: "simulated", billRef: f.A.reference, amount: 1_000, status: "PENDING", loanId: f.A.loanId, simulated: true },
    })).rejects.toThrow(/MobileMoneyTransaction_tenantId_loanId_fkey|Foreign key constraint/)
    const open = await startStkPush(f.db, {
      tenantId: f.B.tenantId, providerId: slowPush.id, loan: { id: f.B.loanId, reference: f.B.reference },
      amountCents: 10_000, phone: "0712 345 678", actorEmail: "b@test.invalid",
    })
    expect(open).toMatchObject({ ok: true })
    const mine = await f.loan()
    expect(await startStkPush(f.db, {
      tenantId: f.A.tenantId, providerId: slowPush.id, loan: { id: mine.loanId, reference: mine.reference },
      amountCents: 10_000, phone: "0712 345 678", actorEmail: "a@test.invalid",
    })).toMatchObject({ ok: true })
  })

  it("keys a transaction per lender: one TransID in two lenders inserts twice, twice in one lender fails", async () => {
    const insert = (id: string, tenantId: string) => f.fresh.db.$executeRawUnsafe(
      `INSERT INTO "MobileMoneyTransaction" ("id", "tenantId", "provider", "transId", "billRef", "amount", "status", "updatedAt")
       VALUES ($1, $2, 'simulated', 'SIMUNIQ001', 'X', 100, 'UNMATCHED', now())`, id, tenantId)
    expect(await insert("u1", f.A.tenantId)).toBe(1)
    expect(await insert("u2", f.B.tenantId)).toBe(1)
    await expect(insert("u3", f.A.tenantId)).rejects.toThrow(/MobileMoneyTransaction_tenantId_provider_transId_key|already exists/)
    const [index] = await f.fresh.db.$queryRawUnsafe<Array<{ def: string }>>(
      `SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'MobileMoneyTransaction_tenantId_provider_transId_key'`)
    expect(index.def).toMatch(/UNIQUE INDEX .*\("tenantId", provider, "transId"\)/)
  })

  it("refuses a zero amount, a whole phone number, a status its columns contradict and a second (tenant, provider, transId)", async () => {
    const insert = (cols: string) => f.fresh.db.$executeRawUnsafe(
      `INSERT INTO "MobileMoneyTransaction" ("id", "tenantId", "provider", "transId", "billRef", "amount", "status", "msisdnLast4", "loanId", "updatedAt")
       VALUES (${cols}, now())`)
    const t = `'${f.A.tenantId}'`
    await expect(insert(`'x1', ${t}, 'simulated', 'SIMCHK0001', 'X', 0, 'UNMATCHED', NULL, NULL`)).rejects.toThrow(/MobileMoneyTransaction_amount_positive/)
    await expect(insert(`'x2', ${t}, 'simulated', 'SIMCHK0002', 'X', 100, 'UNMATCHED', '${PHONE}', NULL`)).rejects.toThrow(/MobileMoneyTransaction_msisdn_last4/)
    await expect(insert(`'x3', ${t}, 'simulated', 'SIMCHK0003', 'X', 100, 'BOOKED', NULL, '${f.A.loanId}'`)).rejects.toThrow(/MobileMoneyTransaction_status_consistent/)
    await expect(insert(`'x4', ${t}, 'simulated', 'SIMCHK0004', 'X', 100, 'REJECTED', NULL, NULL`)).rejects.toThrow(/MobileMoneyTransaction_status_consistent/)
    await expect(insert(`'x5', ${t}, 'simulated', 'SIMIT00001', 'X', 100, 'UNMATCHED', NULL, NULL`)).rejects.toThrow(/Key \("tenantId", provider, .*transId.*already exists/)
  })
})
