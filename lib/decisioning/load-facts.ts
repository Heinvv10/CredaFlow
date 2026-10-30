import { liveOwnAwareDebtInputs } from "@/lib/affordability/own-lender-debt-load"
import {
  InvalidAffordabilityDebtError,
  affordabilityExpenseEvidenceNeedsMleJustification,
  bureauMonthlyObligations,
  createAffordabilityCalculatorEvidence,
  createAffordabilityExpenseEvidence,
  normaliseAffordabilityDebts,
  readAffordabilitySnapshotStore,
  totalAffordabilityDebt,
} from "@/lib/affordability/snapshot"
import { calculateCreditLifePremiumPeriods, createPasqBillingEvidence } from "@/lib/compliance/pasq"
import { approvalBureauCheckUsableWhere, approvalBureauCheckWhere, bureauMaxAgeDays } from "@/lib/compliance/bureau"
import { verifyAppliedCreditLifeDisclosure } from "@/lib/insurance/credit-life-election.server"
import { calculateLoan } from "@/lib/loan-calculator"
import type { prisma } from "@/lib/prisma"
import { liveAffordability, snapshotAffordability, type AffordabilityFacts } from "./affordability-facts"
import type { DecisionFacts } from "./facts"

type Db = Pick<typeof prisma, "loanApplication" | "tenantConfig" | "creditBureauCheck" | "auditLog" | "loan" | "tenant">

export interface LoadedFacts {
  facts: DecisionFacts
  application: { id: string; clientId: string; productId: string; status: string; updatedAt: Date; submittedAt: Date | null; humanReviewRequestedAt: Date | null }
  /** The bureau check the facts read (an evidence reference for the decision log), if any. */
  bureauCheckId: string | null
  /** Whether affordability came from the application's recorded submission snapshot or was worked out from the records now. */
  affordabilitySource: "SNAPSHOT" | "LIVE"
}

export interface LoadOptions {
  /**
   * Use only bureau data already on file for the client (the latest usable check,
   * whatever review it was pulled for) and never wait for a review's own pull.
   * For a rehearsal on an application nobody has started reviewing.
   */
  existingBureauOnly?: boolean
  /**
   * Read affordability from the submission snapshot recorded when the client
   * applied, where there is one (a simulation replays the numbers the decision
   * was made on, not today's). Absent a snapshot the live figures are used.
   */
  preferSnapshot?: boolean
}

const wholeYears = (from: Date, to: Date): number => {
  const years = to.getUTCFullYear() - from.getUTCFullYear()
  const birthdayPassed = to.getUTCMonth() > from.getUTCMonth() || (to.getUTCMonth() === from.getUTCMonth() && to.getUTCDate() >= from.getUTCDate())
  return birthdayPassed ? years : years - 1
}

const wholeMonths = (from: Date, to: Date): number =>
  Math.max(0, (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) - (to.getUTCDate() < from.getUTCDate() ? 1 : 0))

type ApplicationRow = NonNullable<Awaited<ReturnType<Db["loanApplication"]["findFirst"]>>> & {
  product: { interestRatePm: number; productType: string; interestModel: string; initiationFeeModel: "FLAT_PCT" | "NCA_REG42"; initiationFeePct: number; initiationFeeMax: number; monthlyServiceFee: number }
}

/** The instalment the consumer will actually be billed (credit-life premium included), by the approval's own billing helper; null where it cannot be priced. */
function approvalInstalment(application: ApplicationRow, now: Date): { instalmentCents: number | null } {
  try {
    const loanCalc = calculateLoan({
      principal: application.appliedAmount,
      termDays: application.appliedTermDays,
      interestRatePm: application.product.interestRatePm,
      productType: application.product.productType as never,
      interestModel: application.product.interestModel as "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL",
      initiationFeeModel: application.product.initiationFeeModel,
      initiationFeePct: application.product.initiationFeePct,
      initiationFeeMax: application.product.initiationFeeMax,
      monthlyServiceFee: application.product.monthlyServiceFee,
      initiationFeePayment: application.initiationFeePayment,
    }, now)
    const calculator = createAffordabilityCalculatorEvidence(loanCalc, now)
    const disclosure = verifyAppliedCreditLifeDisclosure(application)
    if (!disclosure.ok) return { instalmentCents: loanCalc.monthlyInstalment }
    const billing = createPasqBillingEvidence({
      calculator,
      election: disclosure.evidence.election,
      offered: disclosure.evidence.offered,
      monthlyPremiumCents: disclosure.evidence.monthlyPremiumCents,
      premiumPeriods: calculateCreditLifePremiumPeriods(calculator, application.appliedTermDays),
    })
    return { instalmentCents: billing.recurringPaymentCents }
  } catch {
    // An instalment the calculator cannot price is a missing fact, not a failed decision.
    return { instalmentCents: null }
  }
}

/**
 * Builds the fact model (./facts.ts) for one application from what is on file:
 * client record, product, the current bureau review's check, the audit trail
 * (channel) and the lender's loan book. Affordability comes from the approval
 * path's own helpers (./affordability-facts.ts), so a rule and the approval
 * gate read the same numbers. Read-only. Null when the application is not a
 * consumer application of this lender (no client borrower, or asset finance).
 */
export async function loadDecisionFacts(db: Db, tenantId: string, applicationId: string, now: Date = new Date(), options: LoadOptions = {}): Promise<LoadedFacts | null> {
  const application = await db.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    include: {
      product: true,
      client: { include: { debtObligations: true, expenseBreakdown: true } },
      assetFinanceDeal: { select: { id: true } },
    },
  })
  if (!application?.client || !application.clientId) return null
  // Asset finance (a deal, or any application on an asset-finance product) is decided by its own path, never by this engine.
  if (application.assetFinanceDeal || application.product.productType === "ASSET_FINANCE") return null
  const client = application.client

  const config = await db.tenantConfig.findFirst({ where: { tenantId }, select: { bureauMaxAgeDays: true, ndiBufferPct: true } })
  const bureau = options.existingBureauOnly
    ? await db.creditBureauCheck.findFirst({
        where: { tenantId, clientId: application.clientId, ...approvalBureauCheckUsableWhere({ maxAgeDays: bureauMaxAgeDays(config), now }) },
        orderBy: { createdAt: "desc" },
      })
    : application.bureauReviewGeneration
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

  const income = client.monthlyIncome
  const expenseEvidence = createAffordabilityExpenseEvidence(client)
  const submission = options.preferSnapshot ? readAffordabilitySnapshotStore(application.affordabilityResult).submission : undefined
  let affordability: AffordabilityFacts
  if (submission) {
    affordability = snapshotAffordability(submission)
  } else {
    let declaredDebtCents = 0
    try {
      const debts = await liveOwnAwareDebtInputs(db, tenantId, application.id, application as never)
      declaredDebtCents = Math.max(
        totalAffordabilityDebt(normaliseAffordabilityDebts(debts.application)),
        totalAffordabilityDebt(normaliseAffordabilityDebts(debts.client)),
      )
    } catch (error) {
      // Debt evidence the approval path would refuse: fall back to the plain declared total; the approval's own refusal still stands.
      if (!(error instanceof InvalidAffordabilityDebtError)) throw error
      declaredDebtCents = client.debtObligations.reduce((sum, d) => sum + Math.max(0, d.monthlyInstalment), 0)
    }
    affordability = liveAffordability({
      monthlyIncomeCents: income,
      monthlyExpensesCents: client.monthlyExpenses,
      declaredDebtCents,
      bureauObligationsCents: bureau ? bureauMonthlyObligations(bureau.obligations) : 0,
      proposedInstalmentCents: approvalInstalment(application as ApplicationRow, now).instalmentCents,
      ndiBufferPct: config?.ndiBufferPct ?? 110,
      expensesBelowMinimum: affordabilityExpenseEvidenceNeedsMleJustification(expenseEvidence),
    })
  }

  const noBureau = bureau === null
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
    monthlyDebtCents: affordability.monthlyDebtCents,
    instalmentCents: affordability.instalmentCents,
    ndiCents: affordability.ndiCents,
    ndiCoverPct: affordability.ndiCoverPct,
    affordabilityGatePasses: affordability.affordabilityGatePasses,
    expensesBelowMinimum: affordability.expensesBelowMinimum,
    dtiPct: affordability.dtiPct,
    bureauAvailable: !noBureau,
    bureauScore: bureau && !bureau.unscoreable ? bureau.score : null,
    bureauUnscoreable: noBureau ? null : bureau.unscoreable,
    bureauAdverse: noBureau ? null : bureau.hasAdverse,
    bureauJudgement: noBureau ? null : bureau.hasJudgement,
    bureauNotice: noBureau ? null : bureau.hasNotice,
    bureauUnderDebtReview: noBureau ? null : bureau.underDebtReview,
    bureauDeceased: noBureau ? null : bureau.deceased,
    isRepeatClient: loans.length > 0,
    openLoansCount: loans.filter((l) => l.status === "ACTIVE" || l.status === "RESTRUCTURED").length,
  }
  return {
    facts,
    application: { id: application.id, clientId: application.clientId, productId: application.productId, status: application.status, updatedAt: application.updatedAt, submittedAt: application.submittedAt, humanReviewRequestedAt: application.humanReviewRequestedAt },
    bureauCheckId: bureau?.id ?? null,
    affordabilitySource: submission ? "SNAPSHOT" : "LIVE",
  }
}
