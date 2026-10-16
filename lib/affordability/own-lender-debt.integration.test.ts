/**
 * Real-Postgres test that affordability counts the client's own loans with
 * this lender, on Elize-shaped data from the Fair Score audit (2026-10-16): a
 * declared R870 store account and her own R2,541-a-month loan, 27 days in
 * arrears, which the assessment left out.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/affordability/own-lender-debt.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { Prisma, PrismaClient, type LoanStatus } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { calculateLoan } from "@/lib/loan-calculator"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
import {
  APPROVAL_AFFORDABILITY_POLICY_VERSION,
  createAffordabilityExpenseEvidence,
  createAffordabilitySnapshot,
  createBureauDecisionEvidence,
  normaliseAffordabilityDebts,
  totalAffordabilityDebt,
  type AffordabilityDebtInput,
} from "@/lib/affordability/snapshot"
import { prisma } from "@/lib/prisma"
import { loadOwnLenderDebts, loadOwnLenderDebtsByClient, ownLenderArrears, withOwnLenderDebts, type OwnLenderDebts } from "./own-lender-debt"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

const INSTALMENT = 254_100 // R2,541.00
const DECLARED = 87_000 // R870.00 store account

async function bookLoan(tenant: ChargesTenant, clientId: string, status: LoanStatus, dpd = 0, arrears = 0) {
  const n = randomUUID().replaceAll("-", "").slice(0, 12)
  const product = await db.loanProduct.create({
    data: {
      tenantId: tenant.tenantId, code: `P-${n}`, name: "Personal", productType: "PERSONAL",
      minAmount: 1, maxAmount: 10_000_000, minTermDays: 30, maxTermDays: 1_800,
      interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", monthlyServiceFee: 6_900,
    },
  })
  const app = await db.loanApplication.create({
    data: { tenantId: tenant.tenantId, reference: `APP-${n}`, clientId, productId: product.id, appliedAmount: 3_000_000, appliedTermDays: 540 },
  })
  const loan = await db.loan.create({
    data: {
      tenantId: tenant.tenantId, reference: `LN-${n}`, applicationId: app.id, clientId, productId: product.id,
      principal: 3_000_000, totalInterest: 1_573_800, initiationFee: 0, totalRepayable: 18 * INSTALMENT + 30_000,
      outstandingPrincipal: 2_713_391, startDate: new Date("2026-04-17T10:00:00+02:00"), maturityDate: new Date("2027-10-17T10:00:00+02:00"),
      interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", status, daysInArrears: dpd, arrearsAmount: arrears, monthlyServiceFee: 6_900,
    },
  })
  // Instalment 1 carries the deferred initiation fee; the recurring instalment is row 2's.
  await db.repaymentSchedule.createMany({
    data: Array.from({ length: 18 }, (_, i) => ({
      tenantId: tenant.tenantId, loanId: loan.id, installmentNo: i + 1,
      dueDate: new Date(Date.UTC(2026, 4 + i, 17, 10)),
      principalDue: 100_000, interestDue: INSTALMENT - 100_000 - 6_900, feesDue: 6_900 + (i === 0 ? 30_000 : 0),
      totalDue: INSTALMENT + (i === 0 ? 30_000 : 0),
    })),
  })
  return loan
}

suite.sequential("own-lender loans in affordability (real Postgres)", () => {
  let tenant: ChargesTenant
  let elize = ""
  let activeRef = ""
  let own: OwnLenderDebts
  let declared: AffordabilityDebtInput[]

  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    const n = randomUUID().replaceAll("-", "").slice(0, 11)
    elize = (await db.client.create({
      data: {
        tenantId: tenant.tenantId, idNumber: `85${n}`, firstName: "Elize", lastName: "Test",
        email: `elize.${n}@client.invalid`, phone: "0820000000", monthlyIncome: 1_500_000, monthlyExpenses: 800_000,
      },
    })).id
    await db.existingDebtObligation.create({
      data: { clientId: elize, creditProvider: "Store account", accountType: "RETAIL", outstandingBalance: 400_000, monthlyInstalment: DECLARED },
    })
    activeRef = (await bookLoan(tenant, elize, "ACTIVE", 27, 84_330)).reference
    // Settled: owes nothing, so it is no obligation.
    await bookLoan(tenant, elize, "COMPLETED")
    // Another lender's book: never this lender's own loan.
    const other = await createChargesTenant(db, false)
    const otherClient = await db.client.create({
      data: { tenantId: other.tenantId, idNumber: `86${n}`, firstName: "Elize", lastName: "Test", email: `elize2.${n}@client.invalid`, phone: "0820000000" },
    })
    await bookLoan(other, otherClient.id, "ACTIVE", 5, 10_000)

    own = await loadOwnLenderDebts(prisma, tenant.tenantId, elize)
    declared = (await db.existingDebtObligation.findMany({ where: { clientId: elize } }))
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  it("finds the client's ACTIVE loan with this lender, its recurring instalment and arrears", () => {
    expect(own.lenderNames).toContain("Acme Lending")
    expect(own.loans).toHaveLength(1)
    expect(own.loans[0]).toMatchObject({ reference: activeRef, instalmentCents: INSTALMENT, daysInArrears: 27, arrearsAmount: 84_330 })
    expect(ownLenderArrears(own)).toEqual({ days: 27, amountCents: 84_330 })
  })

  it("gives the new-application client picker the same loans, per client", async () => {
    const byClient = await loadOwnLenderDebtsByClient(prisma, tenant.tenantId)
    expect(byClient.get(elize)).toEqual(own)
    expect([...byClient.keys()]).toEqual([elize])
  })

  it("leaves out the loan booked from the application being viewed", async () => {
    const loan = await db.loan.findFirstOrThrow({ where: { reference: activeRef } })
    expect((await loadOwnLenderDebts(prisma, tenant.tenantId, elize, loan.applicationId)).loans).toEqual([])
  })

  it("counts it on top of the declared R870, once", () => {
    const debts = normaliseAffordabilityDebts(withOwnLenderDebts(declared, own))
    expect(totalAffordabilityDebt(debts)).toBe(DECLARED + INSTALMENT)
    // Declared by reference, or against this lender's name: not counted again.
    const byReference = withOwnLenderDebts([...declared, { sourceId: activeRef, provider: "Acme", type: "LOAN", balance: 0, monthlyInstalment: INSTALMENT }], own)
    expect(totalAffordabilityDebt(normaliseAffordabilityDebts(byReference))).toBe(DECLARED + INSTALMENT)
    const byName = withOwnLenderDebts([...declared, { provider: "ACME LENDING personal loan", type: "LOAN", balance: 0, monthlyInstalment: 200_000 }], own)
    expect(totalAffordabilityDebt(normaliseAffordabilityDebts(byName))).toBe(DECLARED + INSTALMENT)
  })

  it("turns an affordable-looking application into a refusal", () => {
    const calc = calculateLoan({
      principal: 1_000_000, termDays: 360, interestRatePm: 0.02, productType: "PERSONAL", interestModel: "REDUCING_BALANCE",
      initiationFeeModel: "NCA_REG42", initiationFeePct: 0.15, initiationFeeMax: 105_000, monthlyServiceFee: 6_900,
    }, new Date("2026-10-16T10:00:00+02:00"))
    const gate = (debts: AffordabilityDebtInput[]) => evaluateAffordabilityGate({
      monthlyIncomeCents: 1_500_000,
      // Discretionary income clears the instalment with the R870 alone, not with the R2,541 as well.
      monthlyExpensesCents: 1_500_000 - (DECLARED + Math.ceil(calc.monthlyInstalment * 1.1) + 100_000),
      declaredDebtCents: totalAffordabilityDebt(normaliseAffordabilityDebts(debts)),
      bureauObligationsCents: 0,
      proposedInstalmentCents: calc.monthlyInstalment,
      ndiBufferPct: 110,
    })
    expect(gate(declared).blocked).toBe(false)
    expect(gate(withOwnLenderDebts(declared, own)).blocked).toBe(true)
  })

  it("produces approval evidence the database's approval guard accepts", async () => {
    const at = new Date("2026-10-16T10:00:00.000Z")
    const calc = calculateLoan({
      principal: 200_000, termDays: 90, interestRatePm: 0.02, productType: "PERSONAL", interestModel: "REDUCING_BALANCE",
      initiationFeeModel: "NCA_REG42", initiationFeePct: 0.15, initiationFeeMax: 105_000, monthlyServiceFee: 6_900,
    }, at)
    const client = {
      grossMonthlyIncome: 2_000_000, monthlyIncome: 1_800_000, monthlyExpenses: 800_000,
      expenseBreakdown: {
        id: "expense-1", updatedAt: at, housing: 400_000, transport: 150_000, food: 150_000, education: 0,
        insurance: 50_000, clothing: 0, entertainment: 0, medical: 50_000, other: 0, belowMleJustification: null,
      },
    }
    const applicationDebts = normaliseAffordabilityDebts(withOwnLenderDebts([], own))
    const clientDebts = normaliseAffordabilityDebts(withOwnLenderDebts(declared, own))
    const inputs = {
      monthlyIncomeCents: client.monthlyIncome, monthlyExpensesCents: client.monthlyExpenses,
      applicationDebtCents: totalAffordabilityDebt(applicationDebts), clientDebtCents: totalAffordabilityDebt(clientDebts),
      declaredDebtCents: Math.max(totalAffordabilityDebt(applicationDebts), totalAffordabilityDebt(clientDebts)),
      bureauObligationsCents: 0, proposedInstalmentCents: calc.monthlyInstalment, creditLifePremiumCents: 0,
      principalCents: 200_000, termDays: 90, productId: "product-1", interestRatePm: 0.02, productType: "PERSONAL",
      interestModel: "REDUCING_BALANCE" as const, initiationFeeModel: "NCA_REG42" as const, initiationFeePct: 0.15,
      initiationFeeMaxCents: 105_000, monthlyServiceFeeCents: 6_900, initiationFeePayment: "DEFERRED" as const, ndiBufferPct: 110,
    }
    expect(inputs.declaredDebtCents).toBe(DECLARED + INSTALMENT)
    const gate = evaluateAffordabilityGate(inputs)
    expect(gate.blocked).toBe(false)
    const approval = createAffordabilitySnapshot({
      stage: "APPROVAL", policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION, capturedAt: at, capturedById: tenant.userId,
      inputs, applicationDebts, clientDebts, expenseEvidence: createAffordabilityExpenseEvidence(client),
      bureauEvidence: createBureauDecisionEvidence({ check: null, minimumScore: 450, blockAdverse: false, override: { reason: "IT", byId: tenant.userId, at } }),
      calculation: calc, calculationStartDate: at,
      outcome: { netDisposableIncomeCents: gate.ndi, ndiAfterLoanCents: gate.ndi - calc.monthlyInstalment, requiredNdiCents: gate.requiredNdi, isAffordable: true, reason: null },
    })
    const [row] = await db.$queryRaw<Array<{ intact: boolean; consistent: boolean }>>(Prisma.sql`
      SELECT "approvalEvidenceIsIntact"(${JSON.stringify(approval)}::jsonb) AS intact,
             "approvalFinancialsAreConsistent"(${JSON.stringify(approval)}::jsonb) AS consistent
    `)
    expect(row).toEqual({ intact: true, consistent: true })
  })
})
