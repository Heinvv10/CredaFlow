/**
 * One loan's row of a run: stage, exposure, interest in suspense and ECL.
 * Pure; the loader (loan-input.ts) supplies RunLoan and run.ts stores the result.
 */
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { sastCalendarDate } from "@/lib/date/sast"
import { accruedInterestCents, eclCents, exposureAtDefault, interestRaisedBetween, proportionCents, unpaidScheduleAmounts, type GraceDeferral, type ScheduleRow } from "./ecl"
import { resolveParameter } from "./parameters"
import { classifyStage, type PriorStaging, type StagingResult } from "./staging"
import { suspensionApplies } from "./suspension"
import type { EclParameter, Ifrs9Settings, InterestBasis, SicrFlagKind } from "./types"

export interface RunLoan {
  id: string
  reference: string
  productId: string
  contractType: string
  status: string
  collectionsStage: string
  debtReview: boolean
  startDate: Date
  principal: number
  outstandingPrincipal: number
  chargesOutstanding: number
  flags: SicrFlagKind[]
  schedule: Array<{ dueDate: Date; principalDue: number; interestDue: number; feesDue: number; totalDue: number; totalPaid: number }>
  /** The interest a full grace deferred (lib/product-engine), earned in the grace although no row carries it. */
  graceDeferral?: GraceDeferral
}

export interface RunContext {
  settings: Ifrs9Settings
  parameters: readonly EclParameter[]
  runAt: Date
  /** A MONTHLY run's month, first day (yyyy-mm-dd): the net basis adjusts the interest raised from then to the run date. Null for an on-demand run. */
  periodStart?: string | null
  /** Default charges are live for the lender (lib/loan/charges-replay.ts chargesLiveForTenant); Loan.chargesOutstanding counts only then. */
  chargesLive: boolean
}

export interface Assessment {
  dpd: number
  staging: StagingResult
  suspended: boolean
  prior: PriorStaging | null
}

/** The columns of Ifrs9LoanSnapshot a loan contributes (dates as yyyy-mm-dd). */
export interface SnapshotData {
  loanId: string
  runDate: string
  loanStatus: string
  productId: string
  contractType: string
  daysPastDue: number
  stage: 1 | 2 | 3
  triggerStage: 1 | 2 | 3
  previousStage: 1 | 2 | 3 | null
  reasons: string[]
  stageSince: string
  cureStartedOn: string | null
  restructured: boolean
  outstandingPrincipalCents: number
  unpaidInterestCents: number
  unpaidFeesCents: number
  chargesOutstandingCents: number
  accruedInterestCents: number
  interestSuspended: boolean
  suspensionBasis: InterestBasis
  suspendedInterestCents: number
  suspendedDefaultInterestCents: number
  netInterestAdjustmentCents: number
  netDefaultInterestAdjustmentCents: number
  eadCents: number
  parameterScope: string
  pdBps: number
  lgdBps: number
  eclCents: number
}

export function assessLoan(loan: RunLoan, ctx: RunContext, prior: PriorStaging | null): Assessment {
  const runDate = sastCalendarDate(ctx.runAt)
  const { daysInArrears: dpd } = recomputeLoanBalances(loan.principal, loan.schedule, ctx.runAt)
  const staging = classifyStage(
    { dpd, status: loan.status, collectionsStage: loan.collectionsStage, debtReview: loan.debtReview, flags: loan.flags },
    ctx.settings, prior, runDate,
  )
  return { dpd, staging, suspended: suspensionApplies(dpd, staging.stage, loan.contractType, ctx.settings), prior }
}

const scheduleRows = (loan: RunLoan): ScheduleRow[] =>
  loan.schedule.map((r) => ({ ...r, dueDate: sastCalendarDate(r.dueDate) }))

/**
 * `defaultInterestOutstanding`: default interest owed today; `defaultInterestRaised`: default interest charged from the
 * run's month start to the run date. Both are read only for a Stage 3 loan (lib/loan/charges-summary.ts, LoanCharge).
 *
 * Stage 3, full suspension (the prudential basis): all the raised, unpaid interest and the default interest owed are held
 * in suspense, none further accrues, and none of it is provisioned.
 * Stage 3, net basis (IFRS 9 5.4.1(b)): exposure stays gross and nothing is suspended; the interest raised in the month
 * (and the default interest charged in it) times ECL / EAD is the month's adjustment, which the ledger takes out of
 * interest income and out of the ECL expense (lib/accounting/sources-ifrs9.ts).
 */
export function buildSnapshot(loan: RunLoan, ctx: RunContext, a: Assessment, defaultInterestOutstanding: number, defaultInterestRaised = 0): SnapshotData {
  const runDate = sastCalendarDate(ctx.runAt)
  const rows = scheduleRows(loan)
  const unpaid = unpaidScheduleAmounts(rows, runDate)
  const charges = ctx.chargesLive ? loan.chargesOutstanding : 0
  const basis = ctx.settings.stage3InterestBasis
  const full = a.suspended && basis === "FULL_SUSPENSION"
  const net = a.suspended && basis === "NET_BASIS" && ctx.periodStart != null
  const defaultInterest = full && ctx.chargesLive ? Math.min(Math.max(defaultInterestOutstanding, 0), charges) : 0
  // On the full basis no further interest accrues into exposure while it is suspended.
  const accrued = full ? 0 : accruedInterestCents(rows, runDate, sastCalendarDate(loan.startDate), loan.graceDeferral)
  const ead = exposureAtDefault({
    outstandingPrincipalCents: loan.outstandingPrincipal, unpaidInterestCents: unpaid.interestCents, unpaidFeesCents: unpaid.feesCents,
    chargesOutstandingCents: charges, accruedInterestCents: accrued,
    suspendedInterestCents: full ? unpaid.interestCents : 0, suspendedDefaultInterestCents: full ? defaultInterest : 0,
  })
  const parameter = resolveParameter(ctx.parameters, loan, a.staging.stage)
  if (!parameter) throw new Error(`No PD/LGD row covers stage ${a.staging.stage} for loan ${loan.reference}`)
  const ecl = eclCents(ead, parameter.pdBps, parameter.lgdBps)
  const raised = net ? interestRaisedBetween(rows, ctx.periodStart!, runDate) : 0
  const raisedDefault = net && ctx.chargesLive ? Math.max(defaultInterestRaised, 0) : 0
  return {
    loanId: loan.id, runDate, loanStatus: loan.status, productId: loan.productId, contractType: loan.contractType,
    daysPastDue: a.dpd, stage: a.staging.stage, triggerStage: a.staging.triggerStage, previousStage: a.prior?.stage ?? null,
    reasons: a.staging.reasons, stageSince: a.staging.stageSince, cureStartedOn: a.staging.cureStartedOn, restructured: a.staging.restructured,
    outstandingPrincipalCents: loan.outstandingPrincipal, unpaidInterestCents: unpaid.interestCents, unpaidFeesCents: unpaid.feesCents,
    chargesOutstandingCents: charges, accruedInterestCents: accrued, interestSuspended: full, suspensionBasis: basis,
    suspendedInterestCents: full ? unpaid.interestCents : 0, suspendedDefaultInterestCents: defaultInterest,
    netInterestAdjustmentCents: proportionCents(raised, ecl, ead), netDefaultInterestAdjustmentCents: proportionCents(raisedDefault, ecl, ead),
    eadCents: ead, parameterScope: parameter.scopeKey, pdBps: parameter.pdBps, lgdBps: parameter.lgdBps, eclCents: ecl,
  }
}
