/**
 * Shared real-Postgres fixture for the payout integration suites: an
 * engine-disbursed loan whose first payout (simulated, account suffix 1111)
 * FAILED, with a fresh passing AVS so a retry can be requested. Synthetic
 * values only. The caller mocks findVerifiedBankStatementForMandate.
 */
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { avsSubjectFingerprint } from "@/lib/compliance/avs-subject"
import { createChargesLoan, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createDisbursementPayout } from "./disbursement"

export async function failedPayoutLoan(db: PrismaClient, tenant: ChargesTenant, disburser: { id: string; email: string }) {
  const ids = await createChargesLoan(db, tenant)
  const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, select: { applicationId: true, reference: true, clientId: true } })
  const client = await db.client.update({ where: { id: loan.clientId! }, data: { bankName: "FNB", bankBranchCode: "250655", bankAccountNumber: "62000001111", accountType: "SAVINGS" } })
  const { id } = await prisma.$transaction((tx) => createDisbursementPayout(tx, {
    tenantId: tenant.tenantId, applicationId: loan.applicationId, loanId: ids.loanId, providerId: "simulated", amountCents: 200_000, reference: loan.reference,
    beneficiary: { accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001111", accountType: "SAVINGS" },
    user: disburser, avs: { avsCheckId: "it", simulated: true },
  }))
  await db.disbursementPayout.update({ where: { id }, data: { status: "SUBMITTING", submittedAt: new Date(), providerReference: `sim-disburse:${loan.applicationId}-1111` } })
  await db.disbursementPayout.update({ where: { id }, data: { status: "FAILED", failureReason: "account closed" } })
  await new Promise((r) => setTimeout(r, 5))
  await db.avsCheck.create({ data: {
    tenantId: tenant.tenantId, clientId: client.id, applicationId: loan.applicationId, provider: "netcash", subjectFingerprint: avsSubjectFingerprint(client),
    accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001111", accountType: "SAVINGS", passed: true, checks: {},
  } })
  return { loanId: ids.loanId, applicationId: loan.applicationId, payoutId: id, reference: loan.reference }
}
