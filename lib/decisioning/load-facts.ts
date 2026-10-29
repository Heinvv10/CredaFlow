import { assessAffordability } from "@/lib/affordability/ndi"
import { bureauMonthlyObligations } from "@/lib/affordability/snapshot"
import { approvalBureauCheckWhere, bureauMaxAgeDays } from "@/lib/compliance/bureau"
import { calculateLoan } from "@/lib/loan-calculator"
import type { prisma } from "@/lib/prisma"
import type { DecisionFacts } from "./facts"

type Db = Pick<typeof prisma, "loanApplication" | "tenantConfig" | "creditBureauCheck" | "auditLog" | "loan">

export interface LoadedFacts {
  facts: DecisionFacts
  application: { id: string; clientId: string; productId: string; status: string }
  /** The bureau check the facts read (an evidence reference for the decision log), if any. */
  bureauCheckId: string | null
}

const wholeYears = (from: Date, to: Date): number => {
  const years = to.getUTCFullYear() - from.getUTCFullYear()
  const birthdayPassed = to.getUTCMonth() > from.getUTCMonth() || (to.getUTCMonth() === from.getUTCMonth() && to.getUTCDate() >= from.getUTCDate())
  return birthdayPassed ? years : years - 1
}

const wholeMonths = (from: Date, to: Date): number =>
  Math.max(0, (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) - (to.getUTCDate() < from.getUTCDate() ? 1 : 0))

/**
 * Builds the fact model (./facts.ts) for one application from what is on file:
 * client record, product, the current bureau review's check, the audit trail
 * (channel) and the lender's loan book. Read-only. Null when the application
 * is not a consumer application of this lender (no client borrower).
 */
export async function loadDecisionFacts(db: Db, tenantId: string, applicationId: string, now: Date = new Date()): Promise<LoadedFacts | null> {
  const application = await db.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    include: {
      product: true,
      client: { include: { debtObligations: { select: { monthlyInstalment: true } } } },
    },
  })
  if (!application?.client || !application.clientId) return null
  const client = application.client

  const config = await db.tenantConfig.findFirst({ where: { tenantId }, select: { bureauMaxAgeDays: true } })
  const bureau = application.bureauReviewGeneration
    ? await db.creditBureauCheck.findFirst({
        where: approvalBureauCheckWhere({
          tenantId, applicationId, clientId: application.clientId,
          reviewGeneration: application.bureauReviewGeneration, maxAgeDays: bureauMaxAgeDays(config), now,
        }),
        orderBy: { createdAt: "desc" },
      })
    : null

  const submittedByClient = await db.auditLog.findFirst({
    where: { tenantId, action: "APPLICATION_SUBMITTED_BY_CLIENT", entity: "LoanApplication", entityId: applicationId },
    select: { id: true },
  })
  const loans = await db.loan.findMany({ where: { tenantId, clientId: application.clientId }, select: { status: true } })

  const declaredDebt = client.debtObligations.reduce((sum, d) => sum + Math.max(0, d.monthlyInstalment), 0)
  const monthlyDebtCents = Math.max(declaredDebt, bureau ? bureauMonthlyObligations(bureau.obligations) : 0)

  let instalmentCents: number | null = null
  try {
    instalmentCents = calculateLoan({
      principal: application.appliedAmount,
      termDays: application.appliedTermDays,
      interestRatePm: application.product.interestRatePm,
      productType: application.product.productType,
      interestModel: application.product.interestModel as "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL",
      initiationFeeModel: application.product.initiationFeeModel,
      initiationFeePct: application.product.initiationFeePct,
      initiationFeeMax: application.product.initiationFeeMax,
      monthlyServiceFee: application.product.monthlyServiceFee,
      initiationFeePayment: application.initiationFeePayment,
    }, now).monthlyInstalment
  } catch {
    // An instalment the calculator cannot price is a missing fact, not a failed decision.
    instalmentCents = null
  }

  const income = client.monthlyIncome
  const ndi = income > 0
    ? assessAffordability({ monthlyIncomeCents: income, monthlyExpensesCents: client.monthlyExpenses, debts: [{ monthlyInstalment: monthlyDebtCents }], proposedInstalmentCents: instalmentCents ?? 0 }).netDisposableIncome
    : null

  const facts: DecisionFacts = {
    productId: application.productId,
    productCode: application.product.code,
    productType: application.product.productType,
    channel: submittedByClient ? "PORTAL" : "STAFF",
    requestedAmountCents: application.appliedAmount,
    termDays: application.appliedTermDays,
    ageYears: client.dateOfBirth ? wholeYears(client.dateOfBirth, now) : null,
    employmentStatus: client.employmentStatus ?? null,
    incomeSourceType: client.incomeSourceType ?? null,
    employmentMonths: client.employmentStartDate ? wholeMonths(client.employmentStartDate, now) : null,
    monthlyIncomeCents: income,
    monthlyExpensesCents: client.monthlyExpenses,
    monthlyDebtCents,
    instalmentCents,
    ndiCents: ndi,
    ndiCoverPct: ndi !== null && instalmentCents ? Math.round((ndi / instalmentCents) * 100) : null,
    dtiPct: income > 0 && instalmentCents !== null ? Math.round(((monthlyDebtCents + instalmentCents) / income) * 100) : null,
    bureauAvailable: bureau !== null,
    bureauScore: bureau && !bureau.unscoreable ? bureau.score : null,
    bureauUnscoreable: bureau?.unscoreable ?? false,
    bureauAdverse: bureau?.hasAdverse ?? false,
    bureauJudgement: bureau?.hasJudgement ?? false,
    bureauNotice: bureau?.hasNotice ?? false,
    bureauUnderDebtReview: bureau?.underDebtReview ?? false,
    bureauDeceased: bureau?.deceased ?? false,
    isRepeatClient: loans.length > 0,
    openLoansCount: loans.filter((l) => l.status === "ACTIVE" || l.status === "RESTRUCTURED").length,
  }
  return { facts, application: { id: application.id, clientId: application.clientId, productId: application.productId, status: application.status }, bureauCheckId: bureau?.id ?? null }
}
