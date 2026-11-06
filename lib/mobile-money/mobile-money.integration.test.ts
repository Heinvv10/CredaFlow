/**
 * M-Pesa receipts against a migrated PostgreSQL, on a Kenyan instance
 * (migrations 20261108110000_payment_method_mobile_money and
 * 20261108110100_mobile_money_transactions): a paybill payment books exactly
 * one MOBILE_MONEY receipt through applyManualReceipt, a replay or a racing
 * second delivery books nothing, an unknown account reference books nothing,
 * an STK push settles from its simulated callback, and the hand-written CHECKs,
 * the unique key and row-level security hold.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/mobile-money/mobile-money.integration.test.ts
 *
 * The role needs CREATEDB (a throwaway KE database, as
 * lib/jurisdiction/ke-instance-guard.integration.test.ts uses).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ingestMobileMoneyCallback, type MobileMoneyDb } from "./c2b-ingest"
import { simulatedC2BPayment, simulatedMpesa } from "./providers/simulated"
import { startStkPush } from "./stk-push"
import type { SignedCallback } from "./types"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip
const PHONE = "254712345678"

suite("M-Pesa receipts on a Kenyan instance (real DB)", () => {
  let fresh: ThrowawayDb
  let loan: Awaited<ReturnType<typeof createChargesLoan>>
  let reference = ""
  const db = () => fresh.db as unknown as MobileMoneyDb
  const payments = () => fresh.db.payment.count({ where: { loanId: loan.loanId } })
  const deliver = (signed: SignedCallback) => {
    const callback = simulatedMpesa.parseCallback(signed)
    if (!callback) throw new Error("the simulated callback did not verify")
    return ingestMobileMoneyCallback(db(), { tenantId: loan.tenantId, provider: simulatedMpesa, callback })
  }
  const paybill = (transId: string, billRef = ` ${reference.toLowerCase()} `, amountCents = 50_000) =>
    simulatedC2BPayment({ transId, billRef, amountCents, msisdn: PHONE })

  beforeAll(async () => {
    vi.stubEnv("SIMULATED_MPESA_WEBHOOK_SECRET", "it-mpesa-secret")
    fresh = await createThrowawayDb({ instance: { jurisdiction: "KE", currency: "KES" } })
    loan = await createChargesLoan(fresh.db, await createChargesTenant(fresh.db, false))
    reference = (await fresh.db.loan.findUniqueOrThrow({ where: { id: loan.loanId } })).reference
  }, 240_000)
  afterEach(() => { vi.stubEnv("NODE_ENV", "test") })
  afterAll(async () => { vi.unstubAllEnvs(); await fresh?.drop() })

  it("seeds a Kenyan lender billed in shillings", async () => {
    expect(await fresh.db.tenantConfig.findUniqueOrThrow({ where: { tenantId: loan.tenantId } })).toMatchObject({ jurisdiction: "KE", currency: "KES" })
  })

  it("books a paybill payment quoting the loan reference once, as a MOBILE_MONEY receipt with its audit", async () => {
    const out = await deliver(paybill("SIMIT00001"))
    expect(out).toMatchObject({ outcome: "BOOKED" })
    const payment = await fresh.db.payment.findFirstOrThrow({ where: { loanId: loan.loanId } })
    expect(payment).toMatchObject({
      amount: 50_000, paymentMethod: "MOBILE_MONEY", reference: "SIMIT00001", idempotencyKey: "mpesa-c2b:SIMIT00001", allocationStatus: "ALLOCATED",
    })
    expect((await fresh.db.loan.findUniqueOrThrow({ where: { id: loan.loanId } })).totalPaid).toBe(50_000)
    const row = await fresh.db.mobileMoneyTransaction.findFirstOrThrow({ where: { transId: "SIMIT00001" } })
    expect(row).toMatchObject({ status: "BOOKED", loanId: loan.loanId, paymentId: payment.id, msisdnLast4: "5678", simulated: true })
    const recorded = await fresh.db.auditLog.findFirstOrThrow({ where: { tenantId: loan.tenantId, action: "PAYMENT_RECORDED", entityId: loan.loanId } })
    expect(recorded.newValue).toMatchObject({ method: "MOBILE_MONEY", source: "SYSTEM_OBSERVED" })
    const audits = await fresh.db.auditLog.findMany({ where: { tenantId: loan.tenantId, entityId: row.id } })
    expect(audits.map((a) => a.action)).toEqual(["MOBILE_MONEY_RECEIPT_BOOKED"])
    expect(JSON.stringify([row, audits])).not.toContain(PHONE)
  })

  it("books nothing for a replayed TransID", async () => {
    const before = await payments()
    expect(await deliver(paybill("SIMIT00001"))).toEqual({ outcome: "DUPLICATE" })
    expect(await payments()).toBe(before)
  })

  it("books one receipt when two deliveries of a new TransID race", async () => {
    const before = await payments()
    const outcomes = await Promise.all([deliver(paybill("SIMIT00002")), deliver(paybill("SIMIT00002"))])
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["BOOKED", "DUPLICATE"])
    expect(await payments()).toBe(before + 1)
    expect(await fresh.db.mobileMoneyTransaction.count({ where: { transId: "SIMIT00002" } })).toBe(1)
  })

  it("stores an unknown account reference UNMATCHED and books nothing", async () => {
    const before = await payments()
    expect(await deliver(paybill("SIMIT00003", "NO-SUCH-LOAN"))).toMatchObject({ outcome: "UNMATCHED" })
    expect(await payments()).toBe(before)
    expect(await fresh.db.mobileMoneyTransaction.findFirstOrThrow({ where: { transId: "SIMIT00003" } }))
      .toMatchObject({ status: "UNMATCHED", loanId: null, paymentId: null, billRef: "NO-SUCH-LOAN" })
  })

  it("books nothing from a simulated callback where simulation is not permitted", async () => {
    const callback = simulatedMpesa.parseCallback(paybill("SIMIT00004"))
    if (!callback) throw new Error("the simulated callback did not verify")
    vi.stubEnv("NODE_ENV", "production")
    const before = await payments()
    expect(await ingestMobileMoneyCallback(db(), { tenantId: loan.tenantId, provider: simulatedMpesa, callback })).toMatchObject({ outcome: "NEEDS_REVIEW" })
    expect(await payments()).toBe(before)
  })

  it("settles an STK push from its simulated callback: paid books once, 0000 is cancelled", async () => {
    const push = (phone: string) => startStkPush(db(), {
      tenantId: loan.tenantId, providerId: simulatedMpesa.id, loan: { id: loan.loanId, reference },
      amountCents: 20_000, phone, actorEmail: "borrower@test.invalid",
    })
    const before = await payments()
    const paid = await push("0712 345 678")
    expect(paid).toMatchObject({ ok: true, status: "BOOKED" })
    if (!paid.ok) return
    const row = await fresh.db.mobileMoneyTransaction.findUniqueOrThrow({ where: { id: paid.transactionId } })
    expect(row).toMatchObject({ status: "BOOKED", billRef: reference, amount: 20_000, msisdnLast4: "5678" })
    expect(row.checkoutRequestId).toMatch(/^ws_CO_SIM_/)
    expect(await payments()).toBe(before + 1)
    const actions = (await fresh.db.auditLog.findMany({ where: { entityId: row.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action)
    expect(actions).toEqual(["MOBILE_MONEY_STK_REQUESTED", "MOBILE_MONEY_RECEIPT_BOOKED"])

    const cancelled = await push("0712 340 000")
    expect(cancelled).toMatchObject({ ok: true, status: "CANCELLED" })
    expect(await payments()).toBe(before + 1)
  })

  it("refuses a zero amount, a whole phone number, a status its columns contradict and a second (provider, transId)", async () => {
    const insert = (cols: string) => fresh.db.$executeRawUnsafe(
      `INSERT INTO "MobileMoneyTransaction" ("id", "tenantId", "provider", "transId", "billRef", "amount", "status", "msisdnLast4", "paymentId", "loanId", "updatedAt")
       VALUES (${cols}, now())`)
    const t = `'${loan.tenantId}'`
    await expect(insert(`'x1', ${t}, 'simulated', 'SIMCHK0001', 'X', 0, 'UNMATCHED', NULL, NULL, NULL`)).rejects.toThrow(/MobileMoneyTransaction_amount_positive/)
    await expect(insert(`'x2', ${t}, 'simulated', 'SIMCHK0002', 'X', 100, 'UNMATCHED', '${PHONE}', NULL, NULL`)).rejects.toThrow(/MobileMoneyTransaction_msisdn_last4/)
    await expect(insert(`'x3', ${t}, 'simulated', 'SIMCHK0003', 'X', 100, 'BOOKED', NULL, NULL, '${loan.loanId}'`)).rejects.toThrow(/MobileMoneyTransaction_status_consistent/)
    await expect(insert(`'x4', ${t}, 'simulated', 'SIMIT00001', 'X', 100, 'UNMATCHED', NULL, NULL, NULL`)).rejects.toThrow(/Key \(provider, .*transId.*already exists/)
  })

  it("enables and FORCEs row-level security with the tenant policy", async () => {
    const [table] = await fresh.db.$queryRawUnsafe<Array<{ on: boolean; forced: boolean; policies: bigint }>>(
      `SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
       FROM pg_class c WHERE c.relname = 'MobileMoneyTransaction'`)
    expect({ ...table, policies: Number(table.policies) }).toEqual({ on: true, forced: true, policies: 1 })
  })
})
