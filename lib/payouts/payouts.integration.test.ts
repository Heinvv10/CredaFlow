/**
 * Real-Postgres proof that a disbursement is never paid twice: one payout per
 * application (concurrent claims), one provider call per payout (concurrent
 * dispatch), and the payout state machine and terms enforced by the database.
 *
 *   RUN_PAYOUTS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payouts/payouts.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createDisbursementPayout } from "./disbursement"
import { dispatchPayout } from "./dispatch"
import { registerPayoutProvider } from "./registry"
import { resolvePayout } from "./resolve"
import { simulatedPayouts } from "./providers/simulated"

const suite = process.env.RUN_PAYOUTS_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
const actor = () => ({ id: tenant.userId, email: "payout-it@test.invalid" })
// A second LOAN_ADMIN: the checker for anything the disburser may not settle.
const checker = () => ({ id: `${tenant.userId}-chk`, email: "payout-checker@test.invalid" })

async function loanForPayout() {
  const ids = await createChargesLoan(db, tenant)
  const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, select: { applicationId: true, reference: true } })
  return { loanId: ids.loanId, applicationId: loan.applicationId, reference: loan.reference }
}

function claim(loan: Awaited<ReturnType<typeof loanForPayout>>, providerId = "it-stub") {
  return prisma.$transaction((tx) => createDisbursementPayout(tx, {
    tenantId: tenant.tenantId, applicationId: loan.applicationId, loanId: loan.loanId, providerId,
    amountCents: 200_000, reference: loan.reference,
    beneficiary: { accountHolder: "Payout Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001234", accountType: "SAVINGS" },
    user: actor(),
    // The AVS gate itself is the route's (unit-tested there); this suite proves the claim.
    avs: { avsCheckId: "it-avs", simulated: true },
  }))
}

async function refused(work: Promise<unknown>, message: RegExp) {
  const error = await work.then(() => null, (e: unknown) => e)
  expect(error, "expected the database to refuse").not.toBeNull()
  expect(String((error as Error).message)).toMatch(message)
}

const send = vi.fn(async () => {
  await new Promise((r) => setTimeout(r, 30))
  return { kind: "accepted" as const, state: "SUBMITTED" as const, providerReference: "stub-ref" }
})

suite.sequential("payouts (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { payoutsEngineEnabled: true } })
    await db.user.create({ data: { id: checker().id, tenantId: tenant.tenantId, email: `${checker().id}@test.invalid`, password: "x", role: "LOAN_ADMIN" } })
    registerPayoutProvider({
      id: "it-stub", displayName: "IT stub", capabilities: { implemented: true, statusQuery: false, webhooks: false }, simulation: () => null,
      initiatePayout: send, getPayoutStatus: async () => ({ kind: "unsupported" }),
    })
  })
  afterAll(async () => {
    registerPayoutProvider(simulatedPayouts)
    await db.$disconnect()
  })

  it("concurrent disbursements of one application create exactly one payout", async () => {
    const loan = await loanForPayout()
    const results = await Promise.allSettled([claim(loan), claim(loan), claim(loan)])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await db.disbursementPayout.count({ where: { applicationId: loan.applicationId } })).toBe(1)
    expect(await db.auditLog.count({ where: { action: "PAYOUT_CREATED", tenantId: tenant.tenantId, newValue: { path: ["applicationId"], equals: loan.applicationId } } })).toBe(1)
  })

  it("sends nothing while the tenant's payout engine is off", async () => {
    const loan = await loanForPayout()
    const { id } = await claim(loan)
    send.mockClear()
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { payoutsEngineEnabled: false } })
    try {
      const out = await dispatchPayout(prisma, { tenantId: tenant.tenantId, payoutId: id, actor: actor() })
      expect(out.kind).toBe("not_sendable")
      expect(send).not.toHaveBeenCalled()
      expect((await db.disbursementPayout.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING")
    } finally {
      await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { payoutsEngineEnabled: true } })
    }
  })

  it("concurrent dispatches of one payout call the provider once", async () => {
    const loan = await loanForPayout()
    const { id } = await claim(loan)
    send.mockClear()
    const outcomes = await Promise.all([1, 2, 3].map(() => dispatchPayout(prisma, { tenantId: tenant.tenantId, payoutId: id, actor: actor() })))
    expect(send).toHaveBeenCalledTimes(1)
    expect(outcomes.filter((o) => o.kind === "sent")).toHaveLength(1)
    expect(await db.disbursementPayout.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "SUBMITTED", providerReference: "stub-ref" })
    const statuses = (await db.auditLog.findMany({ where: { entityId: id, action: "PAYOUT_STATUS_CHANGED" }, orderBy: { createdAt: "asc" } }))
      .map((a) => (a.newValue as { status: string }).status)
    expect(statuses).toEqual(["SUBMITTING", "SUBMITTED"])
  })

  it("enforces the payout's terms and state machine in the database", async () => {
    const loan = await loanForPayout()
    const { id } = await claim(loan)
    await refused(db.disbursementPayout.update({ where: { id }, data: { amountCents: 1 } }), /terms never change/)
    await refused(db.disbursementPayout.update({ where: { id }, data: { accountNumber: "999" } }), /terms never change/)
    await refused(db.disbursementPayout.update({ where: { id }, data: { status: "PAID" } }), /PENDING -> PAID is not allowed/)
    await refused(db.disbursementPayout.update({ where: { id }, data: { status: "SUBMITTING" } }), /records when it was taken/)
    await refused(db.disbursementPayout.delete({ where: { id } }), /never deleted/)
    await db.disbursementPayout.update({ where: { id }, data: { status: "SUBMITTING", submittedAt: new Date() } })
    await db.disbursementPayout.update({ where: { id }, data: { status: "NEEDS_REVIEW" } })
    await refused(db.disbursementPayout.update({ where: { id }, data: { status: "PAID", paidAt: new Date() } }), /resolved by a named person/)
    await refused(db.disbursementPayout.update({ where: { id }, data: { status: "PENDING" } }), /NEEDS_REVIEW -> PENDING is not allowed/)
    // Maker-checker in the database: the disburser cannot settle it by hand.
    await refused(db.disbursementPayout.update({ where: { id }, data: { status: "PAID", paidAt: new Date(), resolvedById: tenant.userId, resolutionNote: "self" } }), /disburser, the requester or the approver cannot settle/)
    const out = await resolvePayout(prisma, { tenantId: tenant.tenantId, payoutId: id, actor: checker(), request: { action: "confirm_paid", note: "Seen on the bank statement" } })
    expect(out).toEqual({ ok: true, status: "PAID", changed: true })
    await refused(db.disbursementPayout.update({ where: { id }, data: { failureReason: "x" } }), /settled payout is immutable/)
  })

  it("refuses a payout created sent, bound to another application, or for nothing", async () => {
    const loan = await loanForPayout()
    const other = await loanForPayout()
    const base = {
      tenantId: tenant.tenantId, loanId: loan.loanId, applicationId: loan.applicationId, provider: "it-stub",
      idempotencyKey: `disburse:${loan.applicationId}`, amountCents: 100, reference: "R",
      accountHolder: "A", bankName: "B", branchCode: "1", accountNumber: "2", accountType: "S", createdById: tenant.userId, disbursedById: tenant.userId,
    }
    await refused(db.disbursementPayout.create({ data: { ...base, status: "SUBMITTED" } }), /created PENDING and unsent/)
    await refused(db.disbursementPayout.create({ data: { ...base, applicationId: other.applicationId, idempotencyKey: `disburse:${other.applicationId}` } }), /loan booked from its own application/)
    await refused(db.disbursementPayout.create({ data: { ...base, idempotencyKey: "anything-else" } }), /idempotency_key_bound/)
    await refused(db.disbursementPayout.create({ data: { ...base, amountCents: 0 } }), /amount_positive/)
  })
})
