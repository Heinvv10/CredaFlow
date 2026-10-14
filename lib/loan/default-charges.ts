import { allocateReceipt } from "@/lib/loan/receipt-allocation"
import { sastCalendarDay } from "@/lib/loan/settlement"
import { dayOfMonth, daysInMonth, isLastDayOfMonth, isoDay } from "@/lib/loan/day-number"

// Charges that accrue on a loan AFTER a missed instalment. ALL money is CENTS.
//
// Pure and replayed from scratch: the result is derived from the booked
// schedule plus every live receipt and letter, so a back-dated receipt or a
// reversal re-prices the whole history instead of patching a running total.
//
// Rules (NCA s101(1), s103, s126(3) and product rules):
//  - Default interest runs from the day after a missed due date, at the loan's
//    own monthly rate divided by the days in that calendar month, on OVERDUE
//    PRINCIPAL only (no interest on interest). A day's interest is earned only
//    once the day is complete (s103(2)), so the as-of day itself never accrues.
//  - The monthly service fee (on the 1st after maturity, while the schedule is
//    unpaid after that day's receipts) and a default administration charge per
//    Section 129 letter post only while a default is open (something overdue
//    at the end of the previous day), so both count toward the in duplum cap.
//  - A receipt pays all due interest (default and contractual), then all due
//    fees and charges, then principal (s126(3), lib/loan/receipt-allocation.ts).
//    A receipt before `accrueFrom` replays in the order it was booked in:
//    the schedule instalment by instalment.
//  - In duplum (s103(5)): everything that accrues during one default — these
//    charges AND contractual interest/fees/premiums falling due in it — may not
//    exceed the unpaid principal at the moment the default began. The
//    contractual amounts of every instalment due from the start of the default
//    to the end of the schedule are RESERVED against the cap up front, so a
//    charge can never take room a later instalment's interest needs. A default
//    ends only when nothing is overdue and no charge is unpaid; the next one
//    gets a new cap.
//  - `accrueUntil` (the loan's write-off, cancellation or closing): nothing
//    accrues or posts on or after it; receipts are still allocated.
//  - Go-live: nothing accrues or posts before `accrueFrom`. The default itself
//    is tracked from its true start, so the in duplum base is the unpaid
//    principal when it began.

export type ChargeType = "DEFAULT_INTEREST" | "SERVICE_FEE" | "DEFAULT_ADMIN" | "COLLECTION_FEE"

export interface DefaultChargeScheduleRow {
  dueDate: Date
  principalDue: number
  interestDue: number
  feesDue: number
  creditLifePremiumDue?: number
  totalDue: number
}

export interface DefaultChargeReceipt {
  id: string
  /** cents actually applied to the loan (never refund-due excess) */
  amount: number
  /** value date — the day the money reached us */
  receivedAt: Date
}

export interface AdminChargeEvent {
  id: string
  date: Date
  amount: number
}

export interface DefaultChargeInput {
  schedule: DefaultChargeScheduleRow[]
  receipts: DefaultChargeReceipt[]
  adminCharges: AdminChargeEvent[]
  /** fraction per month, e.g. 0.05 */
  interestRatePm: number
  monthlyServiceFee: number
  maturityDate: Date
  asOf: Date
  /** first day any charge may accrue or post (lib/loan/charges-replay.ts) */
  accrueFrom?: Date
  /** no charge accrues or posts on or after this day (write-off, cancellation, closing) */
  accrueUntil?: Date
}

export interface ChargePosting {
  type: ChargeType
  /** SAST calendar day, YYYY-MM-DD */
  day: string
  amount: number
  sourceId?: string
}

export interface ReceiptSplit {
  receiptId: string
  toDefaultInterest: number
  toFees: number
  toSchedule: number
}

export interface DefaultChargeResult {
  /** interest aggregated per calendar month; fees and letters per event */
  postings: ChargePosting[]
  interestAccrued: number
  interestPaid: number
  interestOutstanding: number
  feesAccrued: number
  feesPaid: number
  feesOutstanding: number
  /** receipts allocated to the booked schedule */
  scheduleAllocated: number
  /** per instalment, in input order: its share, and the receipt that completed it */
  scheduleRows: Array<{ paid: number; completedBy: string | null }>
  /** receipts beyond everything owed */
  unallocated: number
  receiptSplits: ReceiptSplit[]
  /** the default in progress at asOf, or null when the loan is not in default */
  inDuplum: { capBase: number; accrued: number; reached: boolean } | null
}

interface Episode {
  startDay: number
  capBase: number
  /** charges accrued in this default, unrounded */
  accrued: number
  /** contractual interest, fees and premiums of instalments due from startDay on */
  reserved: number
}

export function computeDefaultCharges(input: DefaultChargeInput): DefaultChargeResult {
  const rows = input.schedule
    .map((row, index) => ({ ...row, index, dueDay: sastCalendarDay(row.dueDate) }))
    .sort((a, b) => a.dueDay - b.dueDay)
  const endDay = sastCalendarDay(input.asOf)
  const maturityDay = sastCalendarDay(input.maturityDate)
  const accrueFromDay = input.accrueFrom ? sastCalendarDay(input.accrueFrom) : -Infinity
  const untilDay = input.accrueUntil ? sastCalendarDay(input.accrueUntil) : Infinity
  const chargeable = (day: number) => day >= accrueFromDay && day < untilDay
  const scheduleTotal = rows.reduce((sum, row) => sum + row.totalDue, 0)
  // reservedFrom[i]: the non-principal amounts of rows i..end, so an episode's
  // reservation is one lookup rather than a scan per day.
  const reservedFrom = new Array<number>(rows.length + 1).fill(0)
  for (let i = rows.length - 1; i >= 0; i--) {
    reservedFrom[i] = reservedFrom[i + 1] + rows[i].totalDue - rows[i].principalDue
  }

  // Receipts and letters in time order; on a tie the receipt comes first.
  const events = [
    ...input.receipts.map((r, index) => ({ ...r, letter: false, index, at: r.receivedAt.getTime(), day: Math.min(endDay, sastCalendarDay(r.receivedAt)) })),
    ...input.adminCharges.map((l, index) => ({ ...l, letter: true, index, at: l.date.getTime(), day: sastCalendarDay(l.date) }))
      .filter((letter) => letter.day <= endDay),
  ].sort((a, b) => a.day - b.day || a.at - b.at || Number(a.letter) - Number(b.letter) || a.index - b.index)

  const postings: ChargePosting[] = []
  const splits: ReceiptSplit[] = []
  let interestExact = 0
  let interestPosted = 0
  let interestPaid = 0
  let feesAccrued = 0
  let feesPaid = 0
  let pool = 0
  const paid = rows.map(() => 0)
  const completedBy: Array<string | null> = rows.map(() => null)
  let unallocated = 0
  let episode: Episode | null = null

  const headroom = () => episode
    ? Math.max(0, episode.capBase - episode.accrued - episode.reserved)
    : Infinity

  function postFee(day: number, type: ChargeType, amount: number, sourceId?: string) {
    if (!chargeable(day)) return
    const charged = Math.min(amount, Math.floor(headroom()))
    if (charged <= 0) return
    feesAccrued += charged
    if (episode) episode.accrued += charged
    postings.push(sourceId ? { type, day: isoDay(day), amount: charged, sourceId } : { type, day: isoDay(day), amount: charged })
  }

  function postInterestTo(day: number) {
    const amount = Math.round(interestExact) - interestPosted
    if (amount <= 0) return
    interestPosted += amount
    postings.push({ type: "DEFAULT_INTEREST", day: isoDay(day), amount })
  }

  if (rows.length === 0) return emptyResult(input.receipts)
  const firstDay = Math.min(rows[0].dueDay, ...events.map((event) => event.day))
  let next = 0

  for (let day = firstDay; day <= endDay; day++) {
    // 1. The day's receipts and letters in time order. A letter posts only
    //    while a default is open (`episode` still holds the status at the end
    //    of the previous day) and something is still owed at its instant.
    const openAtStart = episode !== null
    for (; next < events.length && events[next].day === day; next++) {
      const event = events[next]
      if (event.letter) {
        const owing = rows.some((row, i) => row.dueDay < day && paid[i] < row.totalDue)
          || Math.round(interestExact) - interestPaid + feesAccrued - feesPaid > 0
        if (openAtStart && owing) postFee(day, "DEFAULT_ADMIN", event.amount, event.id)
        continue
      }
      const before = [...paid]
      const { toDefaultInterest, toFees, toSchedule, unallocated: left } = allocateReceipt({
        amount: event.amount, day, rows, paid, s126: day >= accrueFromDay,
        defaultInterestOwed: Math.round(interestExact) - interestPaid, chargesOwed: feesAccrued - feesPaid,
      })
      rows.forEach((row, i) => { if (before[i] < row.totalDue && paid[i] >= row.totalDue) completedBy[i] = event.id })
      interestPaid += toDefaultInterest
      feesPaid += toFees
      pool += toSchedule
      unallocated += left
      splits.push({ receiptId: event.id, toDefaultInterest, toFees, toSchedule })
    }

    // 3. The post-maturity service fee: inside a default, after the receipts.
    if (episode && dayOfMonth(day) === 1 && day > maturityDay && pool < scheduleTotal) {
      postFee(day, "SERVICE_FEE", input.monthlyServiceFee)
    }

    // 4. End-of-day default status.
    let overdue = false
    let overduePrincipal = 0
    let unpaidPrincipal = 0
    let firstNotYetDue = rows.length
    for (let i = 0; i < rows.length; i++) {
      const principal = Math.min(rows[i].principalDue, Math.max(0, rows[i].totalDue - paid[i]))
      unpaidPrincipal += principal
      if (rows[i].dueDay < day) {
        if (paid[i] < rows[i].totalDue) {
          overdue = true
          overduePrincipal += principal
        }
      } else if (firstNotYetDue === rows.length) {
        firstNotYetDue = i
      }
    }
    if (!episode && overdue) {
      episode = { startDay: day, capBase: unpaidPrincipal, accrued: 0, reserved: reservedFrom[firstNotYetDue] }
    } else if (episode && !overdue && Math.round(interestExact) - interestPaid + feesAccrued - feesPaid <= 0) {
      episode = null
    }

    // 5. Accrue the completed day.
    if (day < endDay && episode && chargeable(day)) {
      const interest = Math.min(
        (overduePrincipal * input.interestRatePm) / daysInMonth(day),
        headroom(),
      )
      interestExact += interest
      episode.accrued += interest
    }
    if (day < endDay && isLastDayOfMonth(day)) postInterestTo(day)
  }
  const lastPostingDay = Math.min(endDay, untilDay) - 1
  if (lastPostingDay >= firstDay) postInterestTo(lastPostingDay)

  const interestAccrued = Math.round(interestExact)
  const current = episode as Episode | null
  let inDuplum: DefaultChargeResult["inDuplum"] = null
  if (current) {
    // What counts against the cap, unclamped: charges plus the reserved
    // contractual amounts.
    const accrued = Math.round(current.accrued + current.reserved)
    inDuplum = { capBase: current.capBase, accrued, reached: accrued >= current.capBase }
  }

  return {
    postings,
    interestAccrued,
    interestPaid,
    interestOutstanding: interestAccrued - interestPaid,
    feesAccrued,
    feesPaid,
    feesOutstanding: feesAccrued - feesPaid,
    scheduleAllocated: pool,
    scheduleRows: input.schedule.map((_, index) => {
      const i = rows.findIndex((row) => row.index === index)
      return { paid: paid[i], completedBy: completedBy[i] }
    }),
    unallocated,
    receiptSplits: splits,
    inDuplum,
  }
}

export function emptyResult(receipts: DefaultChargeReceipt[]): DefaultChargeResult {
  return {
    postings: [],
    interestAccrued: 0,
    interestPaid: 0,
    interestOutstanding: 0,
    feesAccrued: 0,
    feesPaid: 0,
    feesOutstanding: 0,
    scheduleAllocated: 0,
    scheduleRows: [],
    unallocated: receipts.reduce((sum, receipt) => sum + receipt.amount, 0),
    receiptSplits: receipts.map((receipt) => ({
      receiptId: receipt.id, toDefaultInterest: 0, toFees: 0, toSchedule: 0,
    })),
    inDuplum: null,
  }
}
