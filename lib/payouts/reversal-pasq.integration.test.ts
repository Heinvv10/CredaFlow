/**
 * A disbursement reversal on a real PASQ v3 loan (signed agreement, bundled
 * credit life, debit-order mandate) commits under every database guard: the
 * PASQ billing guard keeps the contractual figures, the schedule rows are
 * settled as CANCELLED, the bundled policy is cancelled, and nothing but an
 * approved reversal may make a loan CANCELLED.
 *
 *   RUN_PAYOUTS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payouts/reversal-pasq.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { bookLoan, createApprovedPasqV3Application } from "@/lib/compliance/pasq-v3-application.integration-fixture"
import { createDisbursementPayout } from "./disbursement"
import { decideDisbursementReversal, requestDisbursementReversal } from "./reversal"

const suite = process.env.RUN_PAYOUTS_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

async function reversiblePasqLoan(label: string) {
  const scenario = await createApprovedPasqV3Application(label)
  const loanId = await bookLoan(scenario)
  const users = ["dis", "req", "chk"].map((s) => ({ id: `${scenario.officerId}-${s}`, email: `${scenario.officerId}-${s}@test.invalid` }))
  for (const u of users) await db.user.create({ data: { id: u.id, tenantId: scenario.tenantId, email: u.email, password: "x", role: "LOAN_ADMIN" } })
  const [disburser, requester, checker] = users
  const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId }, select: { applicationId: true, reference: true, principal: true } })
  const { id } = await prisma.$transaction((tx) => createDisbursementPayout(tx, {
    tenantId: scenario.tenantId, applicationId: loan.applicationId, loanId, providerId: "simulated",
    amountCents: loan.principal, reference: loan.reference,
    beneficiary: { accountHolder: "Pasq Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001111", accountType: "SAVINGS" },
    user: disburser, avs: { avsCheckId: "it", simulated: true },
  }))
  await db.disbursementPayout.update({ where: { id }, data: { status: "SUBMITTING", submittedAt: new Date() } })
  await db.disbursementPayout.update({ where: { id }, data: { status: "FAILED", failureReason: "account closed" } })
  return { scenario, loanId, requester, checker }
}

suite.sequential("disbursement reversal of a PASQ v3 loan (real Postgres)", () => {
  afterAll(async () => { await db.$disconnect() })

  it("commits: loan CANCELLED with its signed figures kept, schedule settled, bundled credit life cancelled", async () => {
    const { scenario, loanId, requester, checker } = await reversiblePasqLoan("w6rev")
    const before = await db.loan.findUniqueOrThrow({ where: { id: loanId } })
    const policy = await db.insurancePolicy.findFirstOrThrow({ where: { linkedLoanId: loanId } })
    expect(policy.status).toBe("ACTIVE")

    const req = await runWithTenant(scenario.tenantId, () => requestDisbursementReversal(prisma, { tenantId: scenario.tenantId, loanId, reason: "Bank returned the account as closed", actor: requester }))
    expect(req).toMatchObject({ ok: true })
    const out = await runWithTenant(scenario.tenantId, () => decideDisbursementReversal(prisma, {
      tenantId: scenario.tenantId, reversalId: (req as { reversalId: string }).reversalId, approve: true, note: "Confirmed with the bank", actor: checker,
    }))
    expect(out).toMatchObject({ ok: true, status: "APPROVED" })

    // Committed, not silently rolled back at COMMIT by a deferred guard.
    expect(await db.disbursementReversal.findUniqueOrThrow({ where: { id: (req as { reversalId: string }).reversalId } })).toMatchObject({ status: "APPROVED" })
    const after = await db.loan.findUniqueOrThrow({ where: { id: loanId }, include: { repaymentSchedule: true } })
    expect(after).toMatchObject({ status: "CANCELLED", outstandingPrincipal: 0, arrearsAmount: 0, totalRepayable: before.totalRepayable, totalInterest: before.totalInterest })
    expect(after.repaymentSchedule.every((r) => r.status === "CANCELLED")).toBe(true)
    expect((await db.insurancePolicy.findUniqueOrThrow({ where: { id: policy.id } })).status).toBe("CANCELLED")
    expect(await db.auditLog.count({ where: { entityId: policy.id, action: "POLICY_CANCELLED" } })).toBe(1)
    const decided = await db.auditLog.findFirstOrThrow({ where: { entityId: (req as { reversalId: string }).reversalId, action: "DISBURSEMENT_REVERSAL_DECIDED" } })
    expect(decided.newValue).toMatchObject({ bureauCancellationRequired: false, debitMandate: expect.stringContaining("no mandate register") })
  })

  it("refuses CANCELLED for a loan without an approved disbursement reversal", async () => {
    const { loanId } = await reversiblePasqLoan("w6nocancel")
    await expect(db.loan.update({ where: { id: loanId }, data: { status: "CANCELLED" } })).rejects.toThrow(/approved disbursement reversal/)
  })
})
