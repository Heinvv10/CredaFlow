/**
 * Client-notified payments against a migrated PostgreSQL (Fair Score audit B7):
 * the claim lands in the reconciliation queue with a bell item, allocating it
 * captures exactly one real receipt, rejecting it records who and why, and the
 * hand-written CHECK refuses a status its columns contradict.
 *
 *   RUN_PAYMENT_NOTIFICATIONS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payments/payment-notifications.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import type { PaymentDb, PaymentTx } from "@/lib/loan/apply-payment"
import {
  allocatePaymentNotification,
  recordPaymentNotification,
  rejectPaymentNotification,
} from "./payment-notifications"

const suite = process.env.RUN_PAYMENT_NOTIFICATIONS_IT === "1" ? describe : describe.skip

suite("client-notified payments", () => {
  const prisma = new PrismaClient()
  const db = prisma as unknown as PaymentDb
  const T = "t_pn_it"
  const LOAN = "l_pn_it"
  const INSTALMENT = 254_100
  const agent = { id: "u_pn_agent", email: "pn-agent@test.invalid" }

  beforeAll(async () => {
    await prisma.tenant.upsert({ where: { id: T }, update: {}, create: { id: T, slug: "pn-it", name: "PN IT Tenant" } })
    for (const [uid, role] of [["u_pn_agent", "COLLECTIONS_AGENT"], ["u_pn_admin", "LOAN_ADMIN"]] as const) {
      await prisma.user.upsert({
        where: { id: uid },
        update: {},
        create: { id: uid, tenantId: T, email: `${uid}@test.invalid`, name: uid, password: "not-a-login-hash", role },
      })
    }
    await prisma.client.upsert({
      where: { id: "c_pn" },
      update: {},
      create: { id: "c_pn", tenantId: T, idNumber: "9001015800080", firstName: "Elize", lastName: "Synthetic", email: "pn@test.invalid", phone: "0820000000" },
    })
    await prisma.loanProduct.upsert({
      where: { id: "p_pn" },
      update: {},
      create: {
        id: "p_pn", tenantId: T, code: "PN", name: "PN Product", productType: "PERSONAL", minAmount: 1000,
        maxAmount: 10_000_000, minTermDays: 30, maxTermDays: 365, interestRatePm: 0, interestModel: "FLAT",
      },
    })
    await prisma.loanApplication.upsert({
      where: { id: "a_pn" },
      update: {},
      create: { id: "a_pn", tenantId: T, reference: "PN-APP-1", clientId: "c_pn", productId: "p_pn", appliedAmount: INSTALMENT * 2, appliedTermDays: 60 },
    })
    await prisma.loan.upsert({
      where: { id: LOAN },
      update: {},
      create: {
        id: LOAN, tenantId: T, reference: "PN-LN-1", applicationId: "a_pn", clientId: "c_pn", productId: "p_pn",
        principal: INSTALMENT * 2, totalInterest: 0, initiationFee: 0, totalRepayable: INSTALMENT * 2,
        outstandingPrincipal: INSTALMENT * 2, startDate: new Date("2026-08-17"), maturityDate: new Date("2026-10-17"),
        interestRatePm: 0, interestModel: "FLAT", status: "ACTIVE", monthlyServiceFee: 0,
      },
    })
    for (const [no, due] of [[1, "2026-09-17"], [2, "2026-10-17"]] as const) {
      await prisma.repaymentSchedule.upsert({
        where: { id: `s_pn_${no}` },
        update: {},
        create: {
          id: `s_pn_${no}`, tenantId: T, loanId: LOAN, installmentNo: no, dueDate: new Date(`${due}T06:00:00Z`),
          principalDue: INSTALMENT, interestDue: 0, feesDue: 0, totalDue: INSTALMENT,
        },
      })
    }
    await prisma.clientDocument.upsert({
      where: { id: "d_pn" },
      update: {},
      create: { id: "d_pn", tenantId: T, clientId: "c_pn", docType: "PROOF_OF_PAYMENT", fileUrl: "", fileName: "proof.pdf", uploadedByType: "client" },
    })
  })

  beforeEach(async () => {
    await prisma.paymentNotification.deleteMany({ where: { tenantId: T } })
    await prisma.auditLog.deleteMany({ where: { tenantId: T, entityId: LOAN } })
    await prisma.notification.deleteMany({ where: { tenantId: T } })
    await prisma.payment.deleteMany({ where: { loanId: LOAN } })
    await prisma.repaymentSchedule.updateMany({ where: { loanId: LOAN }, data: { totalPaid: 0, status: "PENDING", paidAt: null } })
    await prisma.loan.update({
      where: { id: LOAN },
      data: { totalPaid: 0, outstandingPrincipal: INSTALMENT * 2, status: "ACTIVE", closedAt: null, lastPaymentDate: null, lastPaymentAmount: null },
    })
  })

  afterAll(async () => { await prisma.$disconnect() })

  const claim = () =>
    prisma.$transaction((tx) => recordPaymentNotification(tx as unknown as PaymentTx, {
      tenantId: T, loanId: LOAN, loanReference: "PN-LN-1", clientId: "c_pn", clientName: "Elize Synthetic",
      amount: 84_330, reference: "EFT SEP", paymentDate: new Date("2026-10-15T00:00:00+02:00"), notes: null,
      documentId: "d_pn", actorEmail: "pn@test.invalid", ipAddress: null,
    }))

  it("queues the claim as PENDING, audits it and rings the bell for the roles that can act on it", async () => {
    const { id } = await claim()
    const row = await prisma.paymentNotification.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ status: "PENDING", amount: 84_330, paymentId: null })
    const bells = await prisma.notification.findMany({ where: { tenantId: T, entityId: id } })
    // The same roles the allocate/reject route admits (COLLECTIONS_AGENT upward).
    expect(bells.map((b) => b.userId).sort()).toEqual(["u_pn_admin", "u_pn_agent"])
    expect(bells[0]).toMatchObject({ type: "PAYMENT_NOTIFIED", entityType: "PaymentNotification" })
    expect(await prisma.auditLog.count({ where: { tenantId: T, entityId: id, action: "PAYMENT_NOTIFICATION_RECEIVED" } })).toBe(1)
    // A claim is not money received.
    expect(await prisma.payment.count({ where: { loanId: LOAN } })).toBe(0)
  })

  it("allocates into exactly one receipt on the loan, even when two staff click at once", async () => {
    const { id } = await claim()
    const results = await Promise.allSettled([
      allocatePaymentNotification(db, { tenantId: T, id, actor: agent }),
      allocatePaymentNotification(db, { tenantId: T, id, actor: agent }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const payments = await prisma.payment.findMany({ where: { loanId: LOAN } })
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({ amount: 84_330, allocationStatus: "ALLOCATED", reference: "EFT SEP" })
    expect(payments[0].receivedAt).toEqual(new Date("2026-10-14T22:00:00.000Z"))
    const row = await prisma.paymentNotification.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ status: "ALLOCATED", paymentId: payments[0].id, resolvedById: agent.id })
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: LOAN } })
    expect(loan.totalPaid).toBe(84_330)
    expect(await prisma.auditLog.count({ where: { tenantId: T, entityId: id, action: "PAYMENT_NOTIFICATION_ALLOCATED" } })).toBe(1)
    // The value date came from the client's report, and the receipt says so.
    const recorded = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: T, entityId: LOAN, action: "PAYMENT_RECORDED" } })
    expect(recorded.newValue).toMatchObject({ source: "CLIENT_ASSERTED" })
  })

  it("records a date staff entered as staff-asserted", async () => {
    const { id } = await claim()
    await allocatePaymentNotification(db, { tenantId: T, id, actor: agent, receivedAt: new Date("2026-10-15T08:00:00Z") })
    const recorded = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: T, entityId: LOAN, action: "PAYMENT_RECORDED" }, orderBy: { createdAt: "desc" } })
    expect(recorded.newValue).toMatchObject({ source: "STAFF_ASSERTED" })
  })

  it("rejects with the reason and refuses to allocate it afterwards", async () => {
    const { id } = await claim()
    await rejectPaymentNotification(db, { tenantId: T, id, actor: agent, reason: "No such deposit on the statement" })
    await expect(allocatePaymentNotification(db, { tenantId: T, id, actor: agent })).rejects.toMatchObject({ code: "ALREADY_RESOLVED" })
    expect(await prisma.paymentNotification.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "REJECTED", rejectReason: "No such deposit on the statement", resolvedById: agent.id,
    })
    expect(await prisma.payment.count({ where: { loanId: LOAN } })).toBe(0)
  })

  it("refuses another tenant's notification as not found", async () => {
    const { id } = await claim()
    await expect(allocatePaymentNotification(db, { tenantId: "t_other", id, actor: agent })).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  describe("the database CHECK", () => {
    const violates = (p: Promise<unknown>, constraint: string) => expect(p).rejects.toThrow(new RegExp(constraint))
    const RESOLUTION = "PaymentNotification_resolution_consistent"

    it("refuses ALLOCATED without the receipt it became", async () => {
      const { id } = await claim()
      await violates(prisma.paymentNotification.update({
        where: { id }, data: { status: "ALLOCATED", resolvedById: agent.id, resolvedAt: new Date() },
      }), RESOLUTION)
    })

    it("refuses REJECTED without a reason", async () => {
      const { id } = await claim()
      await violates(prisma.paymentNotification.update({
        where: { id }, data: { status: "REJECTED", rejectReason: "  ", resolvedById: agent.id, resolvedAt: new Date() },
      }), RESOLUTION)
    })

    it("refuses a resolution left on a PENDING row, and a zero amount", async () => {
      const { id } = await claim()
      await violates(prisma.paymentNotification.update({ where: { id }, data: { resolvedById: agent.id } }), RESOLUTION)
      await violates(prisma.paymentNotification.update({ where: { id }, data: { amount: 0 } }), "PaymentNotification_amount_positive")
    })
  })
})
