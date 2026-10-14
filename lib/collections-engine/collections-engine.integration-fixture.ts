/**
 * A synthetic lender with one active loan for the collections-engine
 * integration suite: two monthly instalments, FLAT at 0% so every receipt
 * allocates whole. Instalment 2 ends in 01 cents, which the simulated rail
 * answers with an NPF unpaid (simulated-scenarios.ts). All values synthetic;
 * every id carries the run suffix so reruns on one database never collide.
 */
import { randomInt, randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"

export interface Fixture {
  tenantId: string
  userId: string
  loanId: string
  rows: { id: string; installmentNo: number }[]
}

export const INSTALMENT_1 = 100_000
export const INSTALMENT_2 = 100_001

export async function createFixture(): Promise<Fixture> {
  // Random, not clock-based: the suite runs under a fake Date.
  const run = randomUUID().replace(/-/g, "").slice(0, 12)
  const tenantId = `t_ce_${run}`
  const userId = `u_ce_${run}`
  const clientId = `c_ce_${run}`
  const productId = `p_ce_${run}`
  const appId = `a_ce_${run}`
  const loanId = `l_ce_${run}`

  await prisma.tenant.create({ data: { id: tenantId, slug: `ce-it-${run}`, name: "Collections IT Lender" } })
  await prisma.tenantConfig.create({ data: { tenantId, collectionsEngineEnabled: true, collectionProvider: "simulated" } })
  await prisma.user.create({
    data: { id: userId, tenantId, email: `ce-admin-${run}@test.invalid`, name: "CE Admin", password: "not-a-real-login-hash", role: "LOAN_ADMIN" },
  })
  await prisma.client.create({
    data: {
      id: clientId, tenantId, idNumber: `9001${String(randomInt(1e9)).padStart(9, "0")}`, firstName: "Synthetic", lastName: "Debtor",
      email: `ce-client-${run}@test.invalid`, phone: "0820000000", bankName: "Test Bank", bankBranchCode: "250655",
      bankAccountNumber: "62000000001", accountType: "CHEQUE", salaryPaymentDay: 25,
    },
  })
  await prisma.loanProduct.create({
    data: {
      id: productId, tenantId, code: `CE${run}`.slice(0, 20), name: "CE Product", productType: "PERSONAL",
      minAmount: 1000, maxAmount: 1_000_000, minTermDays: 30, maxTermDays: 365, interestRatePm: 0, interestModel: "FLAT",
    },
  })
  await prisma.loanApplication.create({
    data: { id: appId, tenantId, reference: `CE-APP-${run}`, clientId, productId, appliedAmount: INSTALMENT_1 + INSTALMENT_2, appliedTermDays: 60 },
  })
  await prisma.loan.create({
    data: {
      id: loanId, tenantId, reference: `CE-LN-${run}`, applicationId: appId, clientId, productId,
      principal: INSTALMENT_1 + INSTALMENT_2, totalInterest: 0, initiationFee: 0,
      totalRepayable: INSTALMENT_1 + INSTALMENT_2, outstandingPrincipal: INSTALMENT_1 + INSTALMENT_2,
      startDate: new Date("2026-09-01T10:00:00Z"), maturityDate: new Date("2026-11-25T10:00:00Z"),
      interestRatePm: 0, interestModel: "FLAT", status: "ACTIVE", monthlyServiceFee: 0,
    },
  })
  const rows = [
    { id: `s1_ce_${run}`, installmentNo: 1, dueDate: new Date("2026-10-25T10:00:00Z"), amount: INSTALMENT_1 },
    { id: `s2_ce_${run}`, installmentNo: 2, dueDate: new Date("2026-11-25T10:00:00Z"), amount: INSTALMENT_2 },
  ]
  for (const r of rows) {
    await prisma.repaymentSchedule.create({
      data: {
        id: r.id, tenantId, loanId, installmentNo: r.installmentNo, dueDate: r.dueDate,
        principalDue: r.amount, interestDue: 0, feesDue: 0, totalDue: r.amount,
      },
    })
  }
  return { tenantId, userId, loanId, rows: rows.map(({ id, installmentNo }) => ({ id, installmentNo })) }
}
