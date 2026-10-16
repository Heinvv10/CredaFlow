import { allocateReceipts, type ScheduleRowLike } from "@/lib/loan/balances"
import { s125InstalmentSettlement, type S125Settlement } from "@/lib/loan/s125-settlement"

const MS_PER_DAY = 86_400_000

export interface SettlementLoanLike {
  principal: number
  totalInterest: number
  totalRepayable: number
  contractualTotalInterest?: number | null
  contractualTotalRepayable?: number | null
  totalPaid: number
  interestRatePm: number
  interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
  startDate: Date
  maturityDate: Date
  /** the loan, so an early-settlement audit row names it */
  id?: string
  // s125 applies to an NCA consumer loan; absent means the column defaults.
  ncaRegime?: string | null
  contractType?: string | null
  initiationFee?: number
  monthlyServiceFee?: number | null
}

export interface SettlementScheduleRow extends ScheduleRowLike {
  id: string
  installmentNo?: number
  /** part of feesDue (lib/compliance/pasq.ts) */
  creditLifePremiumDue?: number
  status?: string
  paidAt?: Date | null
}

/** A row's contractual money as it stood before an early instalment settlement re-priced it. */
export interface ContractualRow {
  id: string
  installmentNo: number | null
  principalDue: number
  interestDue: number
  feesDue: number
  creditLifePremiumDue: number
  totalDue: number
}

export interface ReceiptProjection {
  settlementDue: number
  /** cents actually allocated to the loan — never more than settlementDue */
  appliedAmount: number
  /**
   * cents received above settlementDue. Money the client is owed back, not a
   * repayment: it is deliberately excluded from newTotalPaid and from the
   * schedule so no legal document reports it as collected.
   */
  excessAmount: number
  /**
   * cents of appliedAmount that pay default charges, in the s126(3) order
   * (lib/loan/receipt-allocation.ts). The authoritative split is the replay
   * in syncLoanCharges; this is the projection at the value date. Always 0
   * while charges are off.
   */
  chargesAllocated: number
  newTotalPaid: number
  isCompleted: boolean
  isEarlyDailySettlement: boolean
  /** an NCA s125 early settlement of an instalment loan re-priced its rows */
  isEarlyInstalmentSettlement: boolean
  /** with isEarlyInstalmentSettlement: the rows before re-pricing, for the audit row a reversal restores from */
  contractualRows: ContractualRow[] | null
  loanId: string | null
  accruedInterest: number
  interestRebate: number
  /** service fees and initiation-free fees not charged (with isEarlyInstalmentSettlement) */
  feesRebate: number
  totalInterest: number
  totalRepayable: number
  contractualTotalInterest: number
  contractualTotalRepayable: number
  rows: SettlementScheduleRow[]
}

export function settlementAuditEvidence(projection: ReceiptProjection) {
  return {
    settlementDue: projection.settlementDue,
    // Absent, not 0, while charges are off, so the audit shape is unchanged.
    ...(projection.chargesAllocated > 0
      ? { chargesAllocated: projection.chargesAllocated }
      : {}),
    // The database's early-settlement guard reads these (migration
    // 20261016200000_s125_instalment_settlement), and a reversal restores the
    // contractual rows from them (restoreContractualSchedule).
    ...(projection.isEarlyInstalmentSettlement
      ? {
          earlyInstalmentSettlement: true,
          loanId: projection.loanId,
          feesRebate: projection.feesRebate,
          contractualRows: projection.contractualRows,
        }
      : {}),
    earlyDailySettlement: projection.isEarlyDailySettlement,
    accruedInterest: projection.accruedInterest,
    interestRebate: projection.interestRebate,
    resultingTotalInterest: projection.totalInterest,
    resultingTotalRepayable: projection.totalRepayable,
    contractualTotalInterest: projection.contractualTotalInterest,
    contractualTotalRepayable: projection.contractualTotalRepayable,
  }
}

/**
 * Contractual totals are immutable booking evidence, not payment-progress
 * projections. New loans already persist them at disbursement. Only an actual
 * early DAILY_ACCRUAL settlement may initialize legacy-null values so the
 * audited rebate can be checked against the original contract.
 */
export function receiptContractualTotalsUpdate(
  projection: ReceiptProjection,
) {
  if (!projection.isEarlyDailySettlement && !projection.isEarlyInstalmentSettlement) return {}
  return {
    contractualTotalInterest: projection.contractualTotalInterest,
    contractualTotalRepayable: projection.contractualTotalRepayable,
  }
}

export class SettlementOverpaymentError extends RangeError {
  constructor(readonly maxAmountCents: number) {
    super(`Receipt exceeds settlement amount:${maxAmountCents}`)
    this.name = "SettlementOverpaymentError"
  }
}

interface SettlementTerms {
  settlementDue: number
  settlementTotal: number
  isEarlyDailySettlement: boolean
  /** the s125 re-pricing of an instalment loan settled early, or null */
  instalment: S125Settlement | null
  accruedInterest: number
  contractualTotalInterest: number
  contractualTotalRepayable: number
}

/**
 * The SAST calendar day a timestamp falls on. Exported because every
 * day-boundary decision in the lending domain must agree: a raw `Date`
 * comparison treats a date-only input (parsed as UTC midnight) as a different
 * instant from a same-day wall-clock timestamp, which rejects legitimate
 * same-day captures either side of the 00:00–02:00 SAST window.
 */
export function sastCalendarDay(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const value = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value)
  return Date.UTC(value("year"), value("month") - 1, value("day")) / MS_PER_DAY
}

function elapsedContractDays(startDate: Date, asOf: Date, maturityDate: Date) {
  const fullTermDays = Math.max(
    0,
    sastCalendarDay(maturityDate) - sastCalendarDay(startDate),
  )
  return {
    fullTermDays,
    elapsedDays: Math.min(
      fullTermDays,
      Math.max(0, sastCalendarDay(asOf) - sastCalendarDay(startDate)),
    ),
  }
}

/**
 * s125 on an instalment loan: an NCA consumer loan (not an asset-finance
 * contract) of more than one instalment. DAILY_ACCRUAL bullets keep their own
 * rule below.
 */
export function isS125InstalmentLoan(
  loan: SettlementLoanLike,
  schedule: Array<{ creditLifePremiumDue?: number }>,
): boolean {
  return loan.interestModel !== "DAILY_ACCRUAL"
    && schedule.length > 1
    && loan.ncaRegime === "NCA"
    && loan.contractType === "LOAN"
    && schedule.every((row) => row.creditLifePremiumDue !== undefined)
}

/**
 * The fields s125 re-pricing reads. A caller that loads a loan with a narrow
 * `select` must include them, or an instalment loan cannot be priced: the
 * regime and contract type decide whether s125 applies, and a row's premium
 * sits inside its fees (lib/compliance/pasq.ts).
 */
export const S125_LOAN_SELECT = { ncaRegime: true, contractType: true, initiationFee: true, monthlyServiceFee: true } as const
export const S125_SCHEDULE_SELECT = { installmentNo: true, creditLifePremiumDue: true } as const

const byDueDate = <T extends { dueDate: Date; installmentNo?: number }>(rows: T[]) =>
  [...rows].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || (a.installmentNo ?? 0) - (b.installmentNo ?? 0))

function settlementTerms(args: {
  loan: SettlementLoanLike
  schedule: SettlementScheduleRow[]
  asOf: Date
}): SettlementTerms {
  const { loan, schedule, asOf } = args
  const contractualTotalInterest =
    loan.contractualTotalInterest ?? loan.totalInterest
  const contractualTotalRepayable =
    loan.contractualTotalRepayable ?? loan.totalRepayable

  if (isS125InstalmentLoan(loan, schedule)) {
    const instalment = s125InstalmentSettlement(loan, byDueDate(schedule), asOf)
    if (instalment.rebate > 0) {
      return {
        settlementDue: instalment.settlementDue,
        settlementTotal: instalment.totalRepayable,
        isEarlyDailySettlement: false,
        instalment,
        accruedInterest: instalment.totalInterest,
        contractualTotalInterest,
        contractualTotalRepayable,
      }
    }
  }

  let accruedInterest = contractualTotalInterest
  let settlementTotal = contractualTotalRepayable
  let isEarlyDailySettlement = false

  // Every DAILY_ACCRUAL product currently uses one bullet schedule. Fail
  // closed to the contractual maturity balance if a future multi-row daily
  // product appears; its allocation rules require a separate legal decision.
  if (loan.interestModel === "DAILY_ACCRUAL" && schedule.length === 1) {
    const { fullTermDays, elapsedDays } = elapsedContractDays(
      loan.startDate,
      asOf,
      loan.maturityDate,
    )
    if (fullTermDays > 0 && elapsedDays < fullTermDays) {
      accruedInterest = Math.min(
        contractualTotalInterest,
        Math.round(loan.principal * (loan.interestRatePm / 30) * elapsedDays),
      )
      settlementTotal =
        contractualTotalRepayable
        - contractualTotalInterest
        + accruedInterest
      isEarlyDailySettlement = accruedInterest < contractualTotalInterest
    }
  }

  const settlementDue = Math.max(0, settlementTotal - loan.totalPaid)
  return {
    settlementDue,
    settlementTotal,
    isEarlyDailySettlement,
    instalment: null,
    accruedInterest,
    contractualTotalInterest,
    contractualTotalRepayable,
  }
}

/**
 * What a receipt dated `receivedAt` rebates PURELY because of the back-dating:
 * the difference between pricing it today and pricing it then.
 *
 * This is not `projection.interestRebate`, which also contains the lawful s125
 * early-settlement rebate a client earns simply by paying before maturity.
 * Bounding that would refuse ordinary early settlements; only the portion the
 * date choice creates is a control concern. On an instalment loan the date
 * moves interest, service fees and premiums together (an instalment that fell
 * due in between is owed whole), so the change in the settlement figure is
 * measured, not interest alone.
 */
export function backdatingInterestRebate(args: {
  loan: SettlementLoanLike
  schedule: SettlementScheduleRow[]
  asOf: Date
  receivedAt: Date
  /**
   * The receipt settles the loan at its value date (projection.isCompleted).
   * An instalment loan re-prices only then, so a receipt that does not settle
   * rebates nothing whatever its date. Absent: assumed to settle.
   */
  settles?: boolean
}): { rebateCents: number; accruedInterestAtCaptureCents: number } {
  const now = settlementTerms({ loan: args.loan, schedule: args.schedule, asOf: args.asOf })
  const dated = settlementTerms({ loan: args.loan, schedule: args.schedule, asOf: args.receivedAt })
  if (dated.instalment) {
    return {
      rebateCents: args.settles === false ? 0 : Math.max(0, now.settlementDue - dated.settlementDue),
      accruedInterestAtCaptureCents: now.accruedInterest,
    }
  }
  return {
    rebateCents: Math.max(0, now.accruedInterest - dated.accruedInterest),
    accruedInterestAtCaptureCents: now.accruedInterest,
  }
}

export function currentSettlementAmount(args: {
  loan: SettlementLoanLike
  schedule: SettlementScheduleRow[]
  asOf: Date
  /** default charges outstanding at `asOf` (lib/loan/charges-sync.ts) */
  chargesOutstanding?: number
}): number {
  return settlementTerms(args).settlementDue + (args.chargesOutstanding ?? 0)
}

export function projectReceipt(args: {
  loan: SettlementLoanLike
  schedule: SettlementScheduleRow[]
  amount: number
  /**
   * The date the money actually reached us, NOT the date staff captured it.
   * s125(2)(b) charges interest only up to the settlement date, so accruing to
   * capture time bills the client for the gap.
   */
  asOf: Date
  /**
   * Opt in to splitting a receipt that exceeds settlement instead of rejecting
   * it. Only for callers that persist the excess as a refund-due receipt —
   * everyone else must keep failing closed, because silently absorbing an
   * over-payment collects money the consumer does not owe.
   */
  allowOverpayment?: boolean
  /**
   * Default charges outstanding at the value date (lib/loan/charges-sync.ts).
   * They are owed on top of the schedule and paid before it, so a receipt that
   * covers only charges is a valid receipt, not an over-payment.
   */
  chargesOutstanding?: number
  /**
   * The most this receipt may apply per the default-charges replay
   * (lib/loan/charge-aware-receipt.ts): everything above it is money beyond
   * all that is owed. Absent while charges are off.
   */
  replayCapCents?: number
}): ReceiptProjection {
  const { loan, schedule, amount, allowOverpayment = false } = args
  const chargesOutstanding = args.chargesOutstanding ?? 0
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError("Receipt amount must be a positive integer number of cents")
  }
  const terms = settlementTerms(args)
  const {
    settlementTotal,
    isEarlyDailySettlement,
    accruedInterest,
    contractualTotalInterest,
    contractualTotalRepayable,
  } = terms
  // What settles the loan (s125, plus charges owed) decides completion and the
  // early reprice. The replay cap only bounds how much this receipt applies:
  // a receipt the replay can absorb in full is not thereby a settlement.
  const settlementDue = terms.settlementDue + chargesOutstanding
  const applicable = Math.min(settlementDue, args.replayCapCents ?? Infinity)
  if (amount > applicable && !allowOverpayment) {
    throw new SettlementOverpaymentError(applicable)
  }
  const appliedAmount = Math.min(amount, applicable)
  const excessAmount = amount - appliedAmount
  const chargesAllocated = Math.min(appliedAmount, chargesOutstanding)
  const newTotalPaid = loan.totalPaid + appliedAmount - chargesAllocated
  // An over-payment settles the loan by definition, but a receipt landing on an
  // already-settled loan (settlementDue 0) is pure excess and must not re-close
  // it — hence the explicit > 0 rather than `appliedAmount === settlementDue`.
  const isCompleted = settlementDue > 0 && appliedAmount >= settlementDue
  const applyEarlyReprice = isCompleted && isEarlyDailySettlement
  // s125 on an instalment loan: the receipt that settles it re-prices the rows
  // not yet due to what they earned (lib/loan/s125-settlement.ts).
  const instalment = isCompleted ? terms.instalment : null
  const repriced = applyEarlyReprice || instalment !== null
  const totalInterest = repriced
    ? accruedInterest
    : loan.totalInterest
  const totalRepayable = repriced
    ? settlementTotal
    : loan.totalRepayable
  const priceById = instalment
    ? new Map(byDueDate(schedule).map((row, index) => [row.id, instalment.rows[index]]))
    : null
  const baseRows = applyEarlyReprice
    ? schedule.map((row, index) => index === 0
      ? {
          ...row,
          interestDue: accruedInterest,
          totalDue: row.totalDue - row.interestDue + accruedInterest,
        }
      : { ...row })
    : priceById
      ? schedule.map((row) => ({ ...row, ...priceById.get(row.id)! }))
      : schedule.map((row) => ({ ...row }))
  const allocated = allocateReceipts(baseRows, newTotalPaid)
  const rows = baseRows.map((row, index) => ({
    ...row,
    totalPaid: allocated[index],
  }))

  return {
    settlementDue,
    appliedAmount,
    excessAmount,
    chargesAllocated,
    newTotalPaid,
    isCompleted,
    isEarlyDailySettlement: applyEarlyReprice,
    isEarlyInstalmentSettlement: instalment !== null,
    contractualRows: instalment
      ? schedule.map((row) => ({
          id: row.id,
          installmentNo: row.installmentNo ?? null,
          principalDue: row.principalDue,
          interestDue: row.interestDue,
          feesDue: row.feesDue,
          creditLifePremiumDue: row.creditLifePremiumDue ?? 0,
          totalDue: row.totalDue,
        }))
      : null,
    loanId: loan.id ?? null,
    accruedInterest,
    interestRebate: repriced
      ? contractualTotalInterest - accruedInterest
      : 0,
    feesRebate: instalment
      ? schedule.reduce((sum, row) => sum + row.feesDue, 0) - instalment.rows.reduce((sum, row) => sum + row.feesDue, 0)
      : 0,
    totalInterest,
    totalRepayable,
    contractualTotalInterest,
    contractualTotalRepayable,
    rows,
  }
}

export function restoreContractualBulletSchedule(args: {
  loan: SettlementLoanLike
  schedule: SettlementScheduleRow[]
}): SettlementScheduleRow[] {
  const contractualInterest =
    args.loan.contractualTotalInterest ?? args.loan.totalInterest
  if (
    args.loan.interestModel !== "DAILY_ACCRUAL"
    || args.schedule.length !== 1
    || args.loan.contractualTotalRepayable == null
    || args.loan.contractualTotalInterest == null
    || args.loan.totalRepayable === args.loan.contractualTotalRepayable
  ) {
    return args.schedule.map((row) => ({ ...row }))
  }
  return args.schedule.map((row) => ({
    ...row,
    interestDue: contractualInterest,
    totalDue: args.loan.contractualTotalRepayable!,
  }))
}
