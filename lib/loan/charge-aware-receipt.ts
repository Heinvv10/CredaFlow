import {
  chargesBackdating,
  chargesEnabled,
  loadChargesReplay,
  type ChargesReplay,
  type ChargesTx,
} from "@/lib/loan/charges-replay"
import {
  projectReceipt,
  type ReceiptProjection,
  type SettlementLoanLike,
  type SettlementScheduleRow,
} from "@/lib/loan/settlement"

// Projects a receipt that is about to be booked, with default charges taken
// into account when they are live for the tenant. ALL money is CENTS.
//
// The bound comes from the replay, with the new receipt placed at its value
// date among every receipt already on the loan: whatever the replay cannot
// allocate is money beyond everything owed and is split off as excess. Stored
// Loan.totalPaid is never the bound, because a back-dated receipt re-prices
// charges on the receipts after it. projectReceipt still applies its own
// (s125 early-settlement) bound; the lower of the two wins.
//
// One replay load serves the bound and the back-dating measure. The sync
// after the writes reloads, because the writes (the Payment row, an early
// settlement's repriced bullet) change what it must replay.

const PROBE = "receipt-being-booked"

export interface ChargeAwareProjection {
  projection: ReceiptProjection
  /** default charges the value date writes off, for rejectUnauthorisedBackdating */
  chargesBackdating: { rebateCents: number; accruedAtCaptureCents: number }
}

type ReceiptLoan = SettlementLoanLike & {
  id: string
  tenantId: string
  tenant?: { config: { defaultChargesEnabled: boolean; defaultChargesStartedAt: Date | null } | null } | null
}

interface ReceiptArgs {
  loan: ReceiptLoan
  schedule: SettlementScheduleRow[]
  amount: number
  receivedAt: Date
  asOf: Date
  allowOverpayment?: boolean
}

/** The replay a receipt is bounded by, or null while charges are off. */
export async function loadReceiptReplay(tx: ChargesTx, loan: ReceiptLoan, asOf: Date): Promise<ChargesReplay | null> {
  return chargesEnabled(loan)
    ? await loadChargesReplay(tx, { tenantId: loan.tenantId, loanId: loan.id }, asOf)
    : null
}

/** Pure half: project a receipt against an already-loaded replay. */
export function projectReceiptWithReplay(replay: ChargesReplay | null, args: ReceiptArgs): ChargeAwareProjection {
  const { loan, schedule, amount, receivedAt, asOf, allowOverpayment } = args
  if (!replay) {
    return {
      projection: projectReceipt({ loan, schedule, amount, asOf: receivedAt, allowOverpayment }),
      chargesBackdating: { rebateCents: 0, accruedAtCaptureCents: 0 },
    }
  }
  const dated = replay.replayAt(asOf, [{ id: PROBE, amount, receivedAt }])
  const split = dated.receiptSplits.find((s) => s.receiptId === PROBE)
  const projection = projectReceipt({
    loan,
    schedule,
    amount,
    asOf: receivedAt,
    allowOverpayment,
    chargesOutstanding: (split?.toDefaultInterest ?? 0) + (split?.toFees ?? 0),
    replayCapCents: amount - dated.unallocated,
  })
  // Whether this receipt settles the loan is the replay's call once the
  // amount is known: charges re-priced by its date can leave a few cents of
  // the schedule unpaid. A writer that marked it COMPLETED on the projection
  // alone would also stop the replay accruing at the value date. A lawful
  // early DAILY_ACCRUAL settlement (s125) is projectReceipt's own decision.
  const settled = () => {
    if (projection.appliedAmount === 0) return false
    const after = replay.replayAt(asOf, [{ id: PROBE, amount: projection.appliedAmount, receivedAt }])
    const scheduleTotal = schedule.reduce((sum, row) => sum + row.totalDue, 0)
    return after.scheduleAllocated >= scheduleTotal && after.interestOutstanding + after.feesOutstanding === 0
  }
  return {
    projection: projection.isEarlyDailySettlement ? projection : { ...projection, isCompleted: settled() },
    chargesBackdating: projection.appliedAmount > 0
      ? chargesBackdating(replay, { amount: projection.appliedAmount, receivedAt }, asOf)
      : { rebateCents: 0, accruedAtCaptureCents: 0 },
  }
}

export async function projectChargeAwareReceipt(tx: ChargesTx, args: ReceiptArgs): Promise<ChargeAwareProjection> {
  return projectReceiptWithReplay(await loadReceiptReplay(tx, args.loan, args.asOf), args)
}
