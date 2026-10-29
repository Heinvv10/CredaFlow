/**
 * One loan's row of a run: stage, exposure, interest in suspense and ECL.
 * Pure; the loader (loan-input.ts) supplies RunLoan and run.ts stores the result.
 */
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { sastCalendarDate } from "@/lib/date/sast"
import { accruedInterestCents, eclCents, exposureAtDefault, unpaidScheduleAmounts, type ScheduleRow } from "./ecl"
import { resolveParameter } from "./parameters"
import { classifyStage, type PriorStaging, type StagingResult } from "./staging"
import { suspensionApplies } from "./suspension"
import type { EclParameter, Ifrs9Settings, SicrFlagKind } from "./types"

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
}

export interface RunContext {
  settings: Ifrs9Settings
  parameters: readonly EclParameter[]
  runAt: Date
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
  outstandingPrincipalCents: number
  unpaidInterestCents: number
  unpaidFeesCents: number
  chargesOutstandingCents: number
  accruedInterestCents: number
  interestSuspended: boolean
  suspendedInterestCents: number
  suspendedDefaultInterestCents: number
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
  return { dpd, staging, suspended: suspensionApplies(dpd, staging.stage, ctx.settings), prior }
}

const scheduleRows = (loan: RunLoan): ScheduleRow[] =>
  loan.schedule.map((r) => ({ ...r, dueDate: sastCalendarDate(r.dueDate) }))

/** `defaultInterestOutstanding`: default interest owed today, read only for a suspended loan (lib/loan/charges-summary.ts). */
export function buildSnapshot(loan: RunLoan, ctx: RunContext, a: Assessment, defaultInterestOutstanding: number): SnapshotData {
  const runDate = sastCalendarDate(ctx.runAt)
  const rows = scheduleRows(loan)
  const unpaid = unpaidScheduleAmounts(rows, runDate)
  const charges = ctx.chargesLive ? loan.chargesOutstanding : 0
  const suspendedInterest = a.suspended ? unpaid.interestCents : 0
  const suspendedDefault = a.suspended && ctx.chargesLive ? Math.min(Math.max(defaultInterestOutstanding, 0), charges) : 0
  // Interest in suspense is not recognised, so none further accrues into the exposure.
  const accrued = a.suspended ? 0 : accruedInterestCents(rows, runDate, sastCalendarDate(loan.startDate))
  const ead = exposureAtDefault({
    outstandingPrincipalCents: loan.outstandingPrincipal, unpaidInterestCents: unpaid.interestCents, unpaidFeesCents: unpaid.feesCents,
    chargesOutstandingCents: charges, accruedInterestCents: accrued,
    suspendedInterestCents: suspendedInterest, suspendedDefaultInterestCents: suspendedDefault,
  })
  const parameter = resolveParameter(ctx.parameters, loan, a.staging.stage)
  if (!parameter) throw new Error(`No PD/LGD row covers stage ${a.staging.stage} for loan ${loan.reference}`)
  return {
    loanId: loan.id, runDate, loanStatus: loan.status, productId: loan.productId, contractType: loan.contractType,
    daysPastDue: a.dpd, stage: a.staging.stage, triggerStage: a.staging.triggerStage, previousStage: a.prior?.stage ?? null,
    reasons: a.staging.reasons, stageSince: a.staging.stageSince, cureStartedOn: a.staging.cureStartedOn,
    outstandingPrincipalCents: loan.outstandingPrincipal, unpaidInterestCents: unpaid.interestCents, unpaidFeesCents: unpaid.feesCents,
    chargesOutstandingCents: charges, accruedInterestCents: accrued, interestSuspended: a.suspended,
    suspendedInterestCents: suspendedInterest, suspendedDefaultInterestCents: suspendedDefault,
    eadCents: ead, parameterScope: parameter.scopeKey, pdBps: parameter.pdBps, lgdBps: parameter.lgdBps,
    eclCents: eclCents(ead, parameter.pdBps, parameter.lgdBps),
  }
}
