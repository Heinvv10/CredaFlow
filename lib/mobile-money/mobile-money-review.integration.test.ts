/**
 * M-Pesa money that waits for a person, against a migrated PostgreSQL on a
 * Kenyan instance: staff allocate it once (a race books one receipt), reject it
 * with a reason, never book a simulated one where simulation is forbidden; the
 * charges replay's refusal holds the money UNAPPLIED; and row-level security
 * keeps one lender's M-Pesa rows from another's reads and writes.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/mobile-money/mobile-money-review.integration.test.ts
 *
 * The role needs CREATEDB and CREATEROLE (a throwaway KE database, and a
 * login-less role RLS binds).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { allocateMobileMoney, rejectMobileMoney } from "./review"
import { ingestMobileMoneyCallback } from "./c2b-ingest"
import { simulatedMpesa } from "./providers/simulated"
import { createMobileMoneyFixture, IT_SECRET, type MobileMoneyFixture } from "./mobile-money.integration-fixture"

vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip
const ROLE = "cf_mobile_money_it"

suite("M-Pesa money waiting for a person (real DB)", () => {
  let f: MobileMoneyFixture
  /** A real staff user (AuditLog.userId is a User foreign key). */
  let staff = { id: "", email: "staff@test.invalid" }
  const unmatched = async (tenantId: string, transId: string) => {
    expect(await f.deliver(tenantId, f.paybill(tenantId, transId, "WRONG-REF"))).toMatchObject({ outcome: "UNMATCHED" })
    return f.fresh.db.mobileMoneyTransaction.findFirstOrThrow({ where: { tenantId, transId } })
  }
  const pending = (checkoutRequestId: string | null, amount: number) => f.fresh.db.mobileMoneyTransaction.create({
    data: { tenantId: f.A.tenantId, provider: "simulated", checkoutRequestId, billRef: f.A.reference, amount, status: "PENDING", loanId: f.A.loanId, simulated: true },
  })
  const stkPaid = (co: string, transId: string, amount: string) =>
    f.signed(f.A.tenantId, { type: "STK", checkoutRequestId: co, result: "PAID", transId, amount, msisdn: "254712345678" })
  /** A transaction opened as the application role, bound to `tenantId` as the app binds it. */
  const asLender = <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) => f.fresh.db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${ROLE}`)
    await tx.$queryRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, tenantId)
    return fn(tx)
  })

  beforeAll(async () => {
    vi.stubEnv("SIMULATED_MPESA_WEBHOOK_SECRET", IT_SECRET)
    f = await createMobileMoneyFixture()
    staff = { ...staff, id: f.A.userId }
    const exists = await f.fresh.db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`
    if (exists.length === 0) await f.fresh.db.$executeRawUnsafe(`CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    await f.fresh.db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
    await f.fresh.db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON "MobileMoneyTransaction" TO ${ROLE}`)
  }, 240_000)
  afterEach(() => { vi.stubEnv("NODE_ENV", "test") })
  afterAll(async () => { vi.unstubAllEnvs(); await f?.fresh.drop() })

  it("allocates an unmatched payment to the loan staff name, once, audited", async () => {
    const row = await unmatched(f.A.tenantId, "SIMRV00001")
    const out = await allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: f.A.reference.toLowerCase(), actor: staff })
    expect(out).toMatchObject({ loanId: f.A.loanId, idempotentReplay: false })
    expect(await f.fresh.db.mobileMoneyTransaction.findUniqueOrThrow({ where: { id: row.id } }))
      .toMatchObject({ status: "BOOKED", loanId: f.A.loanId, paymentId: out.payment.id, resolvedById: staff.id })
    expect(await f.fresh.db.payment.findUniqueOrThrow({ where: { id: out.payment.id } }))
      .toMatchObject({ paymentMethod: "MOBILE_MONEY", amount: 50_000, idempotencyKey: "mpesa-c2b:SIMRV00001", capturedBy: staff.id })
    // The receipt's own audit names the staff member who booked it, not the ingest's machine actor.
    expect(await f.fresh.db.auditLog.findFirstOrThrow({ where: { entityId: f.A.loanId, action: "PAYMENT_RECORDED", newValue: { path: ["paymentId"], equals: out.payment.id } } }))
      .toMatchObject({ userId: staff.id, userEmail: staff.email })
    // The allocation's own audit row names the staff member who decided it.
    expect(await f.fresh.db.auditLog.findFirstOrThrow({ where: { entityId: row.id, action: "MOBILE_MONEY_ALLOCATED" } }))
      .toMatchObject({ userId: staff.id, userEmail: staff.email })
    await expect(allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: f.A.reference, actor: staff }))
      .rejects.toMatchObject({ code: "ALREADY_RESOLVED" })
  })

  it("refuses a confirmed amount that is not the payment's own, rather than ignoring it (breaker3 R3-A)", async () => {
    const row = await unmatched(f.A.tenantId, "SIMR3A00001")
    const before = await f.payments(f.A.loanId)
    await expect(allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: f.A.reference, actor: staff, confirmedAmount: 99_900 }))
      .rejects.toMatchObject({ code: "CONFIRMED_AMOUNT_DIFFERS" })
    expect(await f.payments(f.A.loanId)).toBe(before)
    expect((await f.fresh.db.mobileMoneyTransaction.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("UNMATCHED")
  })

  it("keeps the reported amount when a forbidden simulated STK result also differs from the push (breaker3 R3-B)", async () => {
    await pending("ws_CO_SIM_r3b", 50_000)
    const callback = simulatedMpesa.parseCallback({ ...stkPaid("ws_CO_SIM_r3b", "SIMR3B00001", "200.00"), tenantId: f.A.tenantId })
    if (!callback) throw new Error("did not verify")
    vi.stubEnv("NODE_ENV", "production")
    expect(await ingestMobileMoneyCallback(f.db, { tenantId: f.A.tenantId, provider: simulatedMpesa, callback })).toMatchObject({ outcome: "NEEDS_REVIEW" })
    vi.stubEnv("NODE_ENV", "test")
    const row = await f.fresh.db.mobileMoneyTransaction.findFirstOrThrow({ where: { transId: "SIMR3B00001" } })
    expect(row).toMatchObject({ amount: 50_000, reportedAmount: 20_000 })
    await expect(allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: f.A.reference, actor: staff }))
      .rejects.toMatchObject({ code: "AMOUNT_UNCONFIRMED" })
    const out = await allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: f.A.reference, actor: staff, confirmedAmount: 20_000 })
    expect(out.payment.amount).toBe(20_000)
  })

  it("the reported amount is positive, storable and differs from the push (breaker3 R3-E)", async () => {
    const insert = (id: string, reported: string) => f.fresh.db.$executeRawUnsafe(
      `INSERT INTO "MobileMoneyTransaction" ("id", "tenantId", "provider", "transId", "billRef", "amount", "reportedAmount", "status", "reviewReason", "updatedAt")
       VALUES ($1, $2, 'simulated', $3, 'X', 100, ${reported}, 'NEEDS_REVIEW', 'why', now())`, id, f.A.tenantId, `SIMCK${id}`)
    for (const [i, reported] of ["0", "-5", "100"].entries()) {
      await expect(insert(`r3e${i}`, reported), reported).rejects.toThrow(/MobileMoneyTransaction_reported_amount/)
    }
    await expect(insert("r3e9", "3000000000")).rejects.toThrow(/out of range/)
  })

  it("books one receipt when two staff allocate the same payment at once", async () => {
    const loan = await f.loan()
    const row = await unmatched(f.A.tenantId, "SIMRV00002")
    const results = await Promise.allSettled([1, 2].map(() =>
      allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: loan.reference, actor: staff })))
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await f.payments(loan.loanId)).toBe(1)
  })

  it("rejects with the reason and who decided, and refuses to allocate it afterwards", async () => {
    const row = await unmatched(f.A.tenantId, "SIMRV00003")
    await rejectMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, reason: "Paid to us by mistake; reversed by Safaricom", actor: staff })
    expect(await f.fresh.db.mobileMoneyTransaction.findUniqueOrThrow({ where: { id: row.id } }))
      .toMatchObject({ status: "REJECTED", rejectReason: "Paid to us by mistake; reversed by Safaricom", resolvedById: staff.id, paymentId: null })
    expect((await f.fresh.db.auditLog.findMany({ where: { entityId: row.id } })).map((a) => a.action)).toContain("MOBILE_MONEY_REJECTED")
    await expect(allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: f.A.reference, actor: staff }))
      .rejects.toMatchObject({ code: "ALREADY_RESOLVED" })
  })

  it("never books a simulated payment where simulation is forbidden, and never another lender's row or loan", async () => {
    const row = await unmatched(f.A.tenantId, "SIMRV00004")
    vi.stubEnv("NODE_ENV", "production")
    await expect(allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: f.A.reference, actor: staff }))
      .rejects.toMatchObject({ code: "SIMULATION_FORBIDDEN" })
    vi.stubEnv("NODE_ENV", "test")
    await expect(allocateMobileMoney(f.db, { tenantId: f.B.tenantId, id: row.id, loanReference: f.B.reference, actor: staff }))
      .rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: f.B.reference, actor: staff }))
      .rejects.toMatchObject({ code: "LOAN_NOT_FOUND" })
  })

  it("books what the provider reported for an STK amount mismatch, only once staff confirm it (breaker2 N1)", async () => {
    await pending("ws_CO_SIM_n1", 50_000)
    expect(await f.deliver(f.A.tenantId, stkPaid("ws_CO_SIM_n1", "SIMN1000001", "200.00"))).toMatchObject({ outcome: "NEEDS_REVIEW" })
    const row = await f.fresh.db.mobileMoneyTransaction.findFirstOrThrow({ where: { transId: "SIMN1000001" } })
    expect(row).toMatchObject({ amount: 50_000, reportedAmount: 20_000 })
    const alloc = (confirmedAmount?: number) => allocateMobileMoney(f.db, {
      tenantId: f.A.tenantId, id: row.id, loanReference: f.A.reference, actor: staff, ...(confirmedAmount ? { confirmedAmount } : {}),
    })
    await expect(alloc()).rejects.toMatchObject({ code: "AMOUNT_UNCONFIRMED" })
    await expect(alloc(50_000)).rejects.toMatchObject({ code: "AMOUNT_UNCONFIRMED" })
    const out = await alloc(20_000)
    expect(out.payment.amount).toBe(20_000)
    const audit = await f.fresh.db.auditLog.findFirstOrThrow({ where: { entityId: row.id, action: "MOBILE_MONEY_ALLOCATED" } })
    expect(audit.newValue).toMatchObject({ amount: 20_000, requestedAmount: 50_000, reportedAmount: 20_000, amountConfirmedById: staff.id })
  })

  it("resolves a row once under allocate/allocate/reject at once, and never for another lender (breaker2 N2)", async () => {
    const row = await unmatched(f.A.tenantId, "SIMN2000001")
    await expect(allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: f.B.reference, actor: staff })).rejects.toMatchObject({ code: "LOAN_NOT_FOUND" })
    const before = await f.payments(f.A.loanId)
    await Promise.allSettled([
      allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: f.A.reference, actor: staff }),
      allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: f.A.reference, actor: staff }),
      rejectMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, reason: "not ours", actor: staff }),
    ])
    expect((await f.payments(f.A.loanId)) - before).toBeLessThanOrEqual(1)
    await expect(allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: f.A.reference, actor: staff })).rejects.toMatchObject({ code: "ALREADY_RESOLVED" })
    await expect(allocateMobileMoney(f.db, { tenantId: f.B.tenantId, id: row.id, loanReference: f.B.reference, actor: staff })).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("leaves a row reviewable when the chosen loan is closed (breaker2 N3)", async () => {
    const row = await unmatched(f.A.tenantId, "SIMN3000001")
    const closed = await f.loan()
    await f.fresh.db.loan.update({ where: { id: closed.loanId }, data: { status: "COMPLETED" } })
    await expect(allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: closed.reference, actor: staff })).rejects.toMatchObject({ code: "NOT_ACTIVE" })
    expect((await f.fresh.db.mobileMoneyTransaction.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("UNMATCHED")
  })

  it("keeps a real result for a push claimed but never answered, booking nothing (breaker2 N4)", async () => {
    const claim = await pending(null, 10_000)
    const before = await f.payments(f.A.loanId)
    expect(await f.deliver(f.A.tenantId, stkPaid("ws_CO_SIM_orphan", "SIMN4000001", "100.00"))).toMatchObject({ outcome: "UNMATCHED" })
    expect(await f.fresh.db.mobileMoneyTransaction.findFirst({ where: { transId: "SIMN4000001" } })).not.toBeNull()
    expect(await f.payments(f.A.loanId)).toBe(before)
    expect((await f.fresh.db.mobileMoneyTransaction.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe("PENDING")
  })

  it("a paybill confirmation of a payment staff already allocated is a replay (breaker2 N5)", async () => {
    await f.deliver(f.A.tenantId, stkPaid("ws_CO_SIM_n5", "SIMN5000001", "100.00"))
    const row = await f.fresh.db.mobileMoneyTransaction.findFirstOrThrow({ where: { transId: "SIMN5000001" } })
    await allocateMobileMoney(f.db, { tenantId: f.A.tenantId, id: row.id, loanReference: f.A.reference, actor: staff })
    const before = await f.payments(f.A.loanId)
    expect(await f.deliver(f.A.tenantId, f.paybill(f.A.tenantId, "SIMN5000001", f.A.reference, "100.00"))).toEqual({ outcome: "DUPLICATE" })
    expect(await f.payments(f.A.loanId)).toBe(before)
  })

  it("holds the money UNAPPLIED when the charges replay refuses it", async () => {
    const loan = await f.loan({ chargesOn: true })
    await applyManualReceipt(f.fresh.db as unknown as PaymentDb, { loanId: loan.loanId, tenantId: loan.tenantId, amount: 20_000, capturedById: loan.userId })
    // Stored totalPaid above what the receipts allocate: any charges sync would lower it, so it refuses.
    const stored = await f.fresh.db.loan.findUniqueOrThrow({ where: { id: loan.loanId } })
    await f.fresh.db.loan.update({ where: { id: loan.loanId }, data: { totalPaid: stored.totalPaid + 100 } })
    const out = await f.deliver(loan.tenantId, f.paybill(loan.tenantId, "SIMHELD001", loan.reference, "100.00"))
    expect(out).toMatchObject({ outcome: "HELD" })
    const row = await f.fresh.db.mobileMoneyTransaction.findFirstOrThrow({ where: { tenantId: loan.tenantId, transId: "SIMHELD001" } })
    expect(row).toMatchObject({ status: "HELD", loanId: loan.loanId })
    expect(await f.fresh.db.payment.findUniqueOrThrow({ where: { id: row.paymentId ?? "" } }))
      .toMatchObject({ amount: 10_000, paymentMethod: "MOBILE_MONEY", allocationStatus: "UNAPPLIED", reconciliationReason: "charges_refused" })
  })

  it("enables and FORCEs row-level security with the tenant policy", async () => {
    const [table] = await f.fresh.db.$queryRawUnsafe<Array<{ on: boolean; forced: boolean; policies: number }>>(
      `SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
       FROM pg_class c WHERE c.relname = 'MobileMoneyTransaction'`)
    expect(table).toEqual({ on: true, forced: true, policies: 1 })
  })

  it("lender A's application role cannot read, change or create lender B's M-Pesa rows", async () => {
    const b = await unmatched(f.B.tenantId, "SIMRLS0001")
    await unmatched(f.A.tenantId, "SIMRLS0002")
    const seen = await asLender(f.A.tenantId, (tx) => tx.$queryRawUnsafe<Array<{ tenantId: string }>>(`SELECT "tenantId" FROM "MobileMoneyTransaction"`))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((r) => r.tenantId === f.A.tenantId)).toBe(true)
    expect(await asLender(f.A.tenantId, (tx) => tx.$executeRawUnsafe(`UPDATE "MobileMoneyTransaction" SET "billRef" = 'MUTATED' WHERE "id" = $1`, b.id))).toBe(0)
    await expect(asLender(f.A.tenantId, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "MobileMoneyTransaction" ("id", "tenantId", "provider", "transId", "billRef", "amount", "status", "updatedAt")
       VALUES ('rls-x', $1, 'simulated', 'SIMRLSX001', 'X', 100, 'UNMATCHED', now())`, f.B.tenantId))).rejects.toThrow(/row-level security/)
    expect((await f.fresh.db.mobileMoneyTransaction.findUniqueOrThrow({ where: { id: b.id } })).billRef).toBe("WRONG-REF")
  })
})
