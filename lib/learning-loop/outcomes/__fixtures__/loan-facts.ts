// Synthetic loan facts for the outcome tests. No person, no lender: opaque refs only.
import { addDays, addMonths, dayNumber } from "../definition"
import type { ArrearsDayFact, InstalmentFact, LoanFacts } from "../facts"

export const FIRST_DUE = "2026-01-31"

/** Monthly instalments of R1,000 from FIRST_DUE, unpaid unless `paid` says otherwise. */
export function instalments(count: number, paid: Record<number, string | null> = {}): InstalmentFact[] {
  return Array.from({ length: count }, (_, i) => {
    const no = i + 1
    const paidDay = paid[no]
    return {
      ref: `sched-${no}`, installmentNo: no, dueDay: addMonths(FIRST_DUE, i), totalDueCents: 100_000,
      paidInFull: paidDay !== undefined, paidDay: paidDay ?? null,
    }
  })
}

/** One recorded day per day in [from, to), DPD from `dpd(day)`; `skip` leaves days unrecorded. */
export function history(from: string, to: string, dpd: (day: string) => number = () => 0, skip: (day: string) => boolean = () => false, defaulted: (day: string) => boolean = () => false): ArrearsDayFact[] {
  const out: ArrearsDayFact[] = []
  for (let d = from; dayNumber(d) < dayNumber(to); d = addDays(d, 1)) {
    if (!skip(d)) out.push({ day: d, daysInArrears: dpd(d), defaulted: defaulted(d) })
  }
  return out
}

export function loan(overrides: Partial<LoanFacts> = {}): LoanFacts {
  return {
    ref: "loan-1",
    maturityDay: addMonths(FIRST_DUE, 11),
    end: { kind: "OPEN" },
    instalments: instalments(12),
    arrearsHistory: history(FIRST_DUE, addMonths(FIRST_DUE, 13)),
    returns: [],
    ...overrides,
  }
}

/** DPD that climbs one a day from `start` (as an unpaid instalment's does). */
export const climbingFrom = (start: string) => (day: string) => Math.max(0, dayNumber(day) - dayNumber(start))
