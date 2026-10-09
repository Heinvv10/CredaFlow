// How one receipt is spread over what a loan owes at its instant. ALL money is
// CENTS.
//
// s126(3) (`s126: true`): all due interest first (default interest, then the
// contractual interest of every instalment due by that day, oldest first),
// then all due fees and charges (default charges, then those instalments'
// contractual fees and premiums), then their principal. Money left over pays
// the instalments not yet due, one at a time.
//
// Legacy (`s126: false`), used before a loan's charges go live so booked
// history replays as it was booked: default interest, then charges, then the
// schedule instalment by instalment.
//
// Either way an instalment is paid interest, then fees, then principal, so its
// paid total alone says how much principal it has realised — which is what
// recomputeLoanBalances reads back.

export interface AllocationRow {
  /** SAST day number the instalment falls due */
  dueDay: number
  principalDue: number
  interestDue: number
  totalDue: number
}

export interface ReceiptAllocation {
  toDefaultInterest: number
  /** default charges: service fees and letter charges */
  toFees: number
  /** contractual interest, fees and principal, across the instalments */
  toSchedule: number
  /** beyond everything owed */
  unallocated: number
}

/** Splits `amount`, adding each instalment's share to `paid` (same order as `rows`, sorted by due day). */
export function allocateReceipt(args: {
  amount: number
  day: number
  defaultInterestOwed: number
  chargesOwed: number
  rows: AllocationRow[]
  paid: number[]
  s126: boolean
}): ReceiptAllocation {
  const { rows, paid } = args
  let remaining = args.amount
  let toSchedule = 0
  const take = (owed: number) => {
    const taken = Math.min(remaining, Math.max(0, owed))
    remaining -= taken
    return taken
  }
  const fill = (indexes: number[], upTo: (row: AllocationRow) => number) => {
    for (const i of indexes) {
      const taken = take(upTo(rows[i]) - paid[i])
      paid[i] += taken
      toSchedule += taken
    }
  }
  const due = args.s126 ? rows.flatMap((row, i) => (row.dueDay <= args.day ? [i] : [])) : []

  const toDefaultInterest = take(args.defaultInterestOwed)
  fill(due, (row) => row.interestDue)
  const toFees = take(args.chargesOwed)
  fill(due, (row) => row.totalDue - row.principalDue)
  fill(rows.map((_, i) => i), (row) => row.totalDue)
  return { toDefaultInterest, toFees, toSchedule, unallocated: remaining }
}
