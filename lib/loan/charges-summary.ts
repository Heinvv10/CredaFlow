import {
  chargesOutstandingTotal,
  loadChargesReplay,
  type ChargesTx,
  type LoanRef,
} from "@/lib/loan/charges-replay"
import type { ChargePosting, ChargeType, DefaultChargeResult } from "@/lib/loan/default-charges"
import { CHARGE_TYPE_LABELS } from "@/lib/loan/charge-labels"
import { CASH_RECEIPTS } from "@/lib/payments/waiver"
import {
  currentSettlementAmount,
  isS125InstalmentLoan,
  type SettlementLoanLike,
  type SettlementScheduleRow,
} from "@/lib/loan/settlement"

// Read model of a loan's default charges for the staff loan page, the portal
// and the NCA documents. ALL money is CENTS. Computed live from the replay, so
// it is correct to the day it is read, not to the last sync.

export interface ChargeBucket {
  accrued: number
  paid: number
  outstanding: number
}

export { CHARGE_TYPE_LABELS } from "@/lib/loan/charge-labels"

const TYPES = ["DEFAULT_INTEREST", "SERVICE_FEE", "DEFAULT_ADMIN"] as const satisfies readonly ChargeType[]
/** Shown only where one was posted, after the always-present buckets, in this order. */
const OPTIONAL_TYPES = ["COLLECTION_FEE", "RECOVERY_COST"] as const satisfies readonly ChargeType[]
type OptionalType = (typeof OPTIONAL_TYPES)[number]
const isOptional = (type: ChargeType): type is OptionalType => (OPTIONAL_TYPES as readonly ChargeType[]).includes(type)

export interface ChargesSummary {
  /** COLLECTION_FEE (NON_NCA only) and RECOVERY_COST (after a repossession) are present only when one was posted */
  buckets: Record<(typeof TYPES)[number], ChargeBucket> & Partial<Record<OptionalType, ChargeBucket>>
  /** charges owed now, all types */
  outstanding: number
  postings: ChargePosting[]
  inDuplum: DefaultChargeResult["inDuplum"]
}

/**
 * Per-type totals. The engine pays service fees and letter fees as one pool,
 * so fee payments are attributed to fee postings oldest first — the same
 * order they fell due in.
 */
export function summariseCharges(result: DefaultChargeResult): ChargesSummary {
  const buckets = Object.fromEntries(
    TYPES.map((type) => [type, { accrued: 0, paid: 0, outstanding: 0 }]),
  ) as ChargesSummary["buckets"]
  buckets.DEFAULT_INTEREST = {
    accrued: result.interestAccrued,
    paid: result.interestPaid,
    outstanding: result.interestOutstanding,
  }
  let feesPaid = result.feesPaid
  for (const posting of result.postings) {
    if (posting.type === "DEFAULT_INTEREST") continue
    const bucket = isOptional(posting.type)
      ? (buckets[posting.type] ??= { accrued: 0, paid: 0, outstanding: 0 })
      : buckets[posting.type]
    const paid = Math.min(feesPaid, posting.amount)
    feesPaid -= paid
    bucket.accrued += posting.amount
    bucket.paid += paid
    bucket.outstanding += posting.amount - paid
  }
  return {
    buckets,
    outstanding: chargesOutstandingTotal(result),
    postings: result.postings,
    inDuplum: result.inDuplum,
  }
}

/** The per-type buckets in display order; the optional ones only where posted. */
export function chargeBucketRows(summary: ChargesSummary): Array<{ type: ChargeType; bucket: ChargeBucket }> {
  const rows: Array<{ type: ChargeType; bucket: ChargeBucket }> = TYPES.map((type) => ({ type, bucket: summary.buckets[type] }))
  const optional = OPTIONAL_TYPES.flatMap((type) => { const bucket = summary.buckets[type]; return bucket ? [{ type, bucket }] : [] })
  return [...rows, ...optional]
}

/** One line per charge type still owed, for a plain breakdown under a total. */
export function chargeBreakdownLines(summary: ChargesSummary): Array<{ label: string; amount: number }> {
  return chargeBucketRows(summary)
    .filter(({ bucket }) => bucket.outstanding > 0)
    .map(({ type, bucket }) => ({ label: CHARGE_TYPE_LABELS[type], amount: bucket.outstanding }))
}

export interface LoanChargesView extends ChargesSummary {
  goLive: Date | null
  /** first day this loan can be charged; null when exempt */
  accrueFrom: Date | null
  exempt: boolean
  exemptReason: string | null
}

/** The live charges view of one loan, or null while charges are off for its tenant. */
export async function loadLoanCharges(db: ChargesTx, ref: LoanRef, asOf: Date): Promise<LoanChargesView | null> {
  const replay = await loadChargesReplay(db, ref, asOf)
  if (!replay) return null
  return {
    ...summariseCharges(replay.result),
    goLive: replay.goLive,
    accrueFrom: replay.accrueFrom,
    exempt: replay.loan.defaultChargesExempt,
    exemptReason: replay.loan.defaultChargesExemptReason,
  }
}

export interface SettlementFigures {
  /** default charges are live for the tenant */
  live: boolean
  charges: LoanChargesView | null
  chargeLines: Array<{ label: string; amount: number }>
  /** default charges owed today */
  chargesOutstanding: number
  /** everything to settle today, charges included (s125 pricing) */
  totalToSettle: number
  /** contractual interest and fees within totalToSettle */
  interestAndFeesOutstanding: number
  /** schedule arrears plus charges owed: what is overdue now */
  arrearsIncludingCharges: number
  /** cash received: live allocated receipts, waivers excluded */
  paymentsReceived: number
  /** the part of those receipts that paid default charges (kept after a stop) */
  chargeSplitsPaid: number
  /** totalToSettle is the s125 figure (s125Priced), not the contractual remainder */
  s125Priced: boolean
}

/**
 * The loans whose settlement figure is priced under s125 (lib/loan/settlement.ts):
 * an NCA consumer loan of several instalments, or an NCA DAILY_ACCRUAL bullet.
 * For anything else — an asset-finance instalment sale, a NON_NCA loan, a
 * single instalment — currentSettlementAmount is the contractual remainder,
 * unearned interest included, so no document certifies it as what settles.
 */
export function isS125Priced(loan: SettlementLoanLike, schedule: SettlementScheduleRow[]): boolean {
  if (loan.ncaRegime !== "NCA" || loan.contractType !== "LOAN") return false
  return isS125InstalmentLoan(loan, schedule) || (loan.interestModel === "DAILY_ACCRUAL" && schedule.length === 1)
}

/**
 * A CANCELLED loan owes nothing. CANCELLED is reached only through an approved
 * disbursement reversal — the money never reached the borrower
 * (lib/payouts/reversal.ts) — and the database refuses any other way in
 * (guardLoanCancellation). Its contractual figures stay on the row because
 * the PASQ billing guard binds them to the signed agreement.
 */
export function owesNothing(loan: { status?: string | null }): boolean {
  return loan.status === "CANCELLED"
}

/** The loan's own figures as an NCA document states them: zero for a CANCELLED loan. */
/** A schedule row as the documents state it: a reversed loan's CANCELLED row is not due. */
export function documentScheduleRow<T extends { totalDue: number; status: string }>(row: T): T {
  return row.status === "CANCELLED" ? { ...row, totalDue: 0 } : row
}
export function documentLoanFigures(loan: { status?: string | null; totalRepayable: number; outstandingPrincipal: number; daysInArrears?: number | null }) {
  return owesNothing(loan)
    ? { totalRepayable: 0, outstandingPrincipal: 0, daysInArrears: 0 }
    : { totalRepayable: loan.totalRepayable, outstandingPrincipal: loan.outstandingPrincipal, daysInArrears: loan.daysInArrears ?? 0 }
}

/** The settlement a document states, itemised. Charges are 0 while off; everything is 0 for a CANCELLED loan. */
export async function loanSettlementFigures(
  db: ChargesTx,
  loan: SettlementLoanLike & {
    id: string
    tenantId: string
    status?: string | null
    outstandingPrincipal: number
    arrearsAmount: number
    repaymentSchedule: SettlementScheduleRow[]
  },
  asOf: Date,
): Promise<SettlementFigures> {
  if (owesNothing(loan)) {
    const received = await db.payment.aggregate({
      where: { tenantId: loan.tenantId, loanId: loan.id, reversed: false, allocationStatus: "ALLOCATED", ...CASH_RECEIPTS },
      _sum: { amount: true, defaultInterestAllocated: true, chargeFeesAllocated: true },
    })
    return {
      live: false, charges: null, chargeLines: [], chargesOutstanding: 0, totalToSettle: 0,
      interestAndFeesOutstanding: 0, arrearsIncludingCharges: 0, s125Priced: false,
      paymentsReceived: received._sum.amount ?? 0,
      chargeSplitsPaid: (received._sum.defaultInterestAllocated ?? 0) + (received._sum.chargeFeesAllocated ?? 0),
    }
  }
  const charges = await loadLoanCharges(db, { tenantId: loan.tenantId, loanId: loan.id }, asOf)
  const chargesOutstanding = charges?.outstanding ?? 0
  const totalToSettle = currentSettlementAmount({
    loan, schedule: loan.repaymentSchedule, asOf, chargesOutstanding,
  })
  const received = await db.payment.aggregate({
    where: { tenantId: loan.tenantId, loanId: loan.id, reversed: false, allocationStatus: "ALLOCATED", ...CASH_RECEIPTS },
    _sum: { amount: true, defaultInterestAllocated: true, chargeFeesAllocated: true },
  })
  return {
    live: charges !== null,
    charges,
    chargeLines: charges ? chargeBreakdownLines(charges) : [],
    chargesOutstanding,
    totalToSettle,
    interestAndFeesOutstanding: Math.max(0, totalToSettle - chargesOutstanding - loan.outstandingPrincipal),
    arrearsIncludingCharges: loan.arrearsAmount + chargesOutstanding,
    s125Priced: isS125Priced(loan, loan.repaymentSchedule),
    paymentsReceived: received._sum.amount ?? 0,
    chargeSplitsPaid: (received._sum.defaultInterestAllocated ?? 0) + (received._sum.chargeFeesAllocated ?? 0),
  }
}

/**
 * The amounts a Section 129 notice states. While charges are off, exactly the
 * fields and values the notice stated before default charges existed.
 */
export function section129NoticeAmounts(
  loan: { arrearsAmount: number; outstandingPrincipal: number },
  figures: SettlementFigures,
): { arrearsAmount: number; outstandingPrincipal: number; totalOutstanding?: number; chargesOutstanding?: number } {
  if (!figures.live) return { arrearsAmount: loan.arrearsAmount, outstandingPrincipal: loan.outstandingPrincipal }
  return {
    arrearsAmount: figures.arrearsIncludingCharges,
    outstandingPrincipal: loan.outstandingPrincipal,
    totalOutstanding: figures.totalToSettle,
    chargesOutstanding: figures.chargesOutstanding,
  }
}

/**
 * The certificate's "Total Paid to Date" when it must be cash received rather
 * than Loan.totalPaid: while charges are live, or after a stop when receipts
 * paid charges. Undefined for a tenant that never had them (renders as main).
 */
export function certificatePaidToDate(figures: SettlementFigures): number | undefined {
  return figures.live || figures.chargeSplitsPaid > 0 ? figures.paymentsReceived : undefined
}

/**
 * The certificate of balance's itemised settlement block: while charges are
 * live, and for a loan priced under s125 (isS125Priced) whatever the charges.
 * With charges off the certificate used to certify the principal alone, which
 * left out the interest earned since the last instalment (R27,133.91 instead
 * of R27,896.34 on the Fair Score audit's loan). Undefined otherwise: the
 * certificate renders as before rather than certify a contractual remainder.
 * "Total Paid to Date" stays Loan.totalPaid unless cash received differs from
 * it (certificatePaidToDate).
 */
export function certificateSettlement(figures: SettlementFigures) {
  if (!figures.live && !figures.s125Priced) return undefined
  return {
    paymentsReceived: certificatePaidToDate(figures),
    interestAndFeesOutstanding: figures.interestAndFeesOutstanding,
    charges: figures.chargeLines,
    totalToSettle: figures.totalToSettle,
  }
}
