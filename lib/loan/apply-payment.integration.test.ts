/**
 * Real-Postgres integration test for the payment lost-update race.
 *
 * A true lost-update race only manifests against a real database with real
 * transaction isolation — mocked Prisma has no locking semantics — so this test
 * is GATED behind `RUN_DB_IT=1` and a `DATABASE_URL` pointing at a throwaway
 * Postgres. The normal `vitest run` (and CI, which has no DB) skips it.
 *
 * Run it with:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://test:test@127.0.0.1:55432/cf_race_test \
 *     npx vitest run lib/loan/apply-payment.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { PrismaClient } from "@prisma/client"
import { applyManualReceipt, type PaymentDb } from "./apply-payment"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("applyManualReceipt — concurrent receipts do not lose updates (issue #422)", () => {
  // A plain (un-extended) client, cast to the helper's param type. No tenant
  // context is needed because every write passes tenantId explicitly.
  const prisma = new PrismaClient()
  const db = prisma as unknown as PaymentDb
  const id = {
    tenant: "t_race",
    client: "c_race",
    product: "p_race",
    app: "a_race",
    loan: "l_race",
  }
  const PRINCIPAL = 200_000 // R2,000 in cents

  beforeAll(async () => {
    await prisma.tenant.upsert({
      where: { id: id.tenant },
      update: {},
      create: { id: id.tenant, slug: "race-test", name: "Race Test Tenant" },
    })
    await prisma.user.upsert({
      where: { id: "u_race" },
      update: { tenantId: id.tenant, active: true },
      create: {
        id: "u_race",
        tenantId: id.tenant,
        email: "race-agent@test.invalid",
        name: "Race Test Agent",
        password: "not-a-real-login-hash",
        role: "COLLECTIONS_AGENT",
      },
    })
    await prisma.client.upsert({
      where: { id: id.client },
      update: {},
      create: {
        id: id.client, tenantId: id.tenant, idNumber: "9001015800080",
        firstName: "Race", lastName: "Test", email: "race@test.local", phone: "0820000000",
      },
    })
    await prisma.loanProduct.upsert({
      where: { id: id.product },
      update: {},
      create: {
        id: id.product, tenantId: id.tenant, code: "RACE", name: "Race Product",
        productType: "PERSONAL", minAmount: 1000, maxAmount: 1_000_000,
        minTermDays: 30, maxTermDays: 365, interestRatePm: 0, interestModel: "FLAT",
      },
    })
    await prisma.loanApplication.upsert({
      where: { id: id.app },
      update: {},
      create: {
        id: id.app, tenantId: id.tenant, reference: "RACE-APP-1", clientId: id.client,
        productId: id.product, appliedAmount: PRINCIPAL, appliedTermDays: 30,
      },
    })
    await prisma.loan.upsert({
      where: { id: id.loan },
      update: {},
      create: {
        id: id.loan, tenantId: id.tenant, reference: "RACE-LN-1", applicationId: id.app,
        clientId: id.client, productId: id.product,
        principal: PRINCIPAL, totalInterest: 0, initiationFee: 0,
        totalRepayable: PRINCIPAL, outstandingPrincipal: PRINCIPAL,
        startDate: new Date("2026-01-01"), maturityDate: new Date("2026-02-01"),
        interestRatePm: 0, interestModel: "FLAT", status: "ACTIVE", monthlyServiceFee: 0,
      },
    })
    await prisma.repaymentSchedule.upsert({
      where: { id: "s_race" },
      update: {},
      create: {
        id: "s_race", tenantId: id.tenant, loanId: id.loan, installmentNo: 1,
        dueDate: new Date("2026-02-01"), principalDue: PRINCIPAL, interestDue: 0,
        feesDue: 0, totalDue: PRINCIPAL,
      },
    })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    // Reset to a clean, unpaid loan before each run.
    await purgeAuditRowsForTest(prisma, { tenantId: id.tenant, entityId: id.loan })
    await prisma.payment.deleteMany({ where: { loanId: id.loan } })
    await prisma.repaymentSchedule.updateMany({
      where: { loanId: id.loan },
      data: { totalPaid: 0, status: "PENDING", paidAt: null },
    })
    await prisma.loan.update({
      where: { id: id.loan },
      data: {
        totalPaid: 0,
        outstandingPrincipal: PRINCIPAL,
        status: "ACTIVE",
        closedAt: null,
        lastPaymentDate: null,
        lastPaymentAmount: null,
        arrearsAmount: 0,
        daysInArrears: 0,
      },
    })
  })

  it("five concurrent R200 receipts settle to totalPaid == sum(payments), no lost update", async () => {
    const N = 5
    const each = 20_000 // R200 in cents; 5 * R200 = R1,000

    await Promise.all(
      Array.from({ length: N }, () =>
        applyManualReceipt(db, {
          loanId: id.loan, tenantId: id.tenant, amount: each, capturedById: "u_race",
        }),
      ),
    )

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: id.loan } })
    const payments = await prisma.payment.findMany({ where: { loanId: id.loan } })
    const paymentSum = payments.reduce((s, p) => s + p.amount, 0)
    const rows = await prisma.repaymentSchedule.findMany({ where: { loanId: id.loan } })
    const rowPaidSum = rows.reduce((s, r) => s + r.totalPaid, 0)

    // All receipts persisted...
    expect(payments.length).toBe(N)
    expect(paymentSum).toBe(N * each)
    // ...and the loan's balance reflects EVERY one of them (the race dropped some).
    expect(loan.totalPaid).toBe(N * each)
    // ...and the schedule stays consistent with the loan balance.
    expect(rowPaidSum).toBe(loan.totalPaid)
  })

  it("two concurrent requests with one idempotency key apply exactly one receipt and one audit", async () => {
    const key = "550e8400-e29b-41d4-a716-446655440000"
    const capture = () => applyManualReceipt(db, {
      loanId: id.loan,
      tenantId: id.tenant,
      amount: 20_000,
      paymentMethod: "EFT",
      capturedById: "u_race",
      capturedByEmail: "race-agent@test.invalid",
      idempotencyKey: key,
    })

    const results = await Promise.all([capture(), capture()])
    const payments = await prisma.payment.findMany({ where: { loanId: id.loan } })
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: id.loan } })
    const audits = await prisma.auditLog.findMany({
      where: { tenantId: id.tenant, entityId: id.loan, action: "PAYMENT_RECORDED" },
    })

    expect(results.map((result) => result.idempotentReplay).sort()).toEqual([false, true])
    expect(results[0]?.payment.id).toBe(results[1]?.payment.id)
    expect(payments).toHaveLength(1)
    expect(payments[0]).toEqual(expect.objectContaining({ amount: 20_000, idempotencyKey: key }))
    expect(loan.totalPaid).toBe(20_000)
    expect(audits).toHaveLength(1)
  })

  it("rolls back the receipt and balances when mandatory audit persistence fails", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION payment_audit_fail_test() RETURNS trigger AS $$
      BEGIN
        IF NEW."tenantId" = 't_race' AND NEW."action" = 'PAYMENT_RECORDED' THEN
          RAISE EXCEPTION 'synthetic payment audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER payment_audit_fail_test
      BEFORE INSERT ON "AuditLog"
      FOR EACH ROW EXECUTE FUNCTION payment_audit_fail_test()
    `)

    try {
      await expect(applyManualReceipt(db, {
        loanId: id.loan,
        tenantId: id.tenant,
        amount: 20_000,
        capturedById: "u_race",
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440001",
      })).rejects.toThrow(/synthetic payment audit failure/i)
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS payment_audit_fail_test ON "AuditLog"`)
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS payment_audit_fail_test()")
    }

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: id.loan } })
    expect(await prisma.payment.count({ where: { loanId: id.loan } })).toBe(0)
    expect(loan.totalPaid).toBe(0)
    expect(loan.lastPaymentDate).toBeNull()
    expect(await prisma.auditLog.count({ where: { tenantId: id.tenant, entityId: id.loan } })).toBe(0)
  })
})
