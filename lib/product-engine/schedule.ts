/**
 * The repayment schedule generator: pure, integer cents, no database. One place turns a principal, a rate and a
 * repayment structure (types.ts) into rows that add up to the cent, for the quote, the signed agreement and the booked
 * loan alike. Reusable by loan changes (restructure, top-up, payment holiday): give it the balance, the rate and the
 * terms that remain.
 *
 * Interest per period is the monthly rate x 12 / periods per year (the monthly rate itself for a monthly period).
 * REDUCING_BALANCE charges it on the balance left; FLAT charges the monthly rate on the original principal for the
 * whole term (P x rate x 12 x periods / periods per year) and splits it evenly. Every remainder lands on the last row,
 * so principal, interest and fees each add up exactly and the last closing balance is 0.
 */
import { evenly } from "./evenly"
import { graceRuleProblems } from "./grace-rules"
import { addCalendarMonths, addPeriods } from "./periods"
import { PERIOD_DAYS, PERIODS_PER_YEAR, type EngineInterestModel, type GeneratedSchedule, type RepaymentTerms, type ScheduleRowOut } from "./types"

export interface ScheduleInput {
  principalCents: number
  /** Monthly rate as a decimal: 0.05 = 5% a month. */
  interestRatePm: number
  interestModel: EngineInterestModel
  monthlyServiceFeeCents: number
  startDate: Date
  terms: RepaymentTerms
}

/** Throws when the terms contradict themselves; the product configuration refuses the same cases before they get here. */
export function assertValidTerms(terms: RepaymentTerms): void {
  const { instalments, graceKind, graceInstalments, structure } = terms
  if (!Number.isInteger(instalments) || instalments < 1) throw new Error("instalments must be a whole number of at least 1")
  if (!Number.isInteger(graceInstalments) || graceInstalments < 0) throw new Error("graceInstalments must be a whole number, 0 or more")
  const rule = graceRuleProblems(structure, graceKind, graceInstalments)[0]
  if (rule) throw new Error(rule.message)
  if (graceInstalments >= instalments && graceKind !== "NONE") throw new Error("the grace must leave at least 1 instalment to pay")
}

function periodRate(interestRatePm: number, terms: RepaymentTerms): number {
  return terms.frequency === "MONTHLY" ? interestRatePm : (interestRatePm * 12) / PERIODS_PER_YEAR[terms.frequency]
}

interface Parts {
  principal: number[]
  interest: number[]
  /** The interest of a full grace, which no row of the grace carries: it is inside the interest of the rows that follow. */
  deferred: number
}

/** Principal and interest of every row, before dates and fees. */
function split(input: ScheduleInput): Parts {
  const { principalCents: P, interestModel, terms } = input
  const { instalments: N, structure, graceKind, graceInstalments: G } = terms
  const r = periodRate(input.interestRatePm, terms)
  const repayRows = graceKind === "FULL" ? N - G : N
  // Rows that pay interest only before the principal starts: the principal-only grace.
  const lead = graceKind === "PRINCIPAL_ONLY" ? G : 0

  if (structure === "BULLET") {
    const interest = Math.round(P * r * N)
    return { principal: [P], interest: [interest], deferred: 0 }
  }

  if (interestModel === "FLAT") {
    const total = Math.round((P * input.interestRatePm * 12 * N) / PERIODS_PER_YEAR[terms.frequency])
    const rows = repayRows
    const principal = structure === "AMORTISING"
      ? [...Array.from({ length: lead }, () => 0), ...evenly(P, rows - lead)]
      : Array.from({ length: rows }, (_, i) => (i === rows - 1 ? P : 0))
    return { principal, interest: evenly(total, rows), deferred: graceKind === "FULL" ? Math.round((total * G) / N) : 0 }
  }

  // REDUCING_BALANCE. The interest of a full grace is the simple interest of those periods on the principal, deferred.
  const perPeriod = Math.round(P * r)
  const deferred = graceKind === "FULL" ? perPeriod * G : 0
  const deferredShare = evenly(deferred, repayRows)
  const principal: number[] = []
  const interest: number[] = []

  if (structure === "INTEREST_ONLY") {
    for (let i = 0; i < repayRows; i++) {
      principal.push(i === repayRows - 1 ? P : 0)
      interest.push(perPeriod + deferredShare[i]!)
    }
    return { principal, interest, deferred }
  }

  // AMORTISING: the principal-only grace rows first, then the annuity of the whole principal over the rest.
  const m = repayRows - lead
  const instalment = r === 0 ? Math.round(P / m) : Math.round((P * r) / (1 - Math.pow(1 + r, -m)))
  for (let i = 0; i < lead; i++) {
    principal.push(0)
    interest.push(perPeriod)
  }
  // Each row's principal is what the instalment leaves after its own interest, never more than the balance and never below
  // 0 (rounding can leave the instalment a cent under the interest); the last row clears whatever balance is left.
  let balance = P
  for (let i = 0; i < m; i++) {
    const own = Math.round(balance * r)
    const due = i === m - 1 ? balance : Math.min(Math.max(instalment - own, 0), balance)
    principal.push(due)
    interest.push(own + deferredShare[lead + i]!)
    balance -= due
  }
  return { principal, interest, deferred }
}

export function generateSchedule(input: ScheduleInput): GeneratedSchedule {
  const { principalCents, terms, startDate } = input
  if (!Number.isInteger(principalCents) || principalCents <= 0) throw new Error("principalCents must be a positive whole number of cents")
  assertValidTerms(terms)

  const { principal, interest, deferred } = split(input)
  const first = terms.graceKind === "FULL" ? terms.graceInstalments : 0
  const single = terms.structure === "BULLET"
  const dueAt = (row: number) => addPeriods(startDate, terms.frequency, single ? terms.instalments : first + row + 1)

  // Service fee: one per month of the term (30-day months, rounded as the single-payment loans do, at least 1), each on
  // the first instalment due on or after that month's end, or on the last. Monthly: one on every instalment. The months of
  // a full grace owe their fee with the rest of the loan, spread over the instalments that follow like the deferred
  // interest, so the first payment is not a pile of fees.
  const months = Math.max(1, Math.round((terms.instalments * PERIOD_DAYS[terms.frequency]) / 30))
  const graceMonths = terms.graceKind === "FULL" ? Math.min(Math.round((terms.graceInstalments * PERIOD_DAYS[terms.frequency]) / 30), months - 1) : 0
  const graceEnd = terms.graceKind === "FULL" ? addPeriods(startDate, terms.frequency, terms.graceInstalments) : startDate
  const dueDates = principal.map((_, i) => dueAt(i))
  const fees = principal.map(() => 0)
  if (input.monthlyServiceFeeCents > 0) {
    for (let month = 1; month <= months - graceMonths; month++) {
      const monthEnd = addCalendarMonths(graceEnd, month).getTime()
      const index = dueDates.findIndex((d) => d.getTime() >= monthEnd)
      fees[index === -1 ? fees.length - 1 : index]! += input.monthlyServiceFeeCents
    }
    evenly(graceMonths * input.monthlyServiceFeeCents, fees.length).forEach((share, i) => { fees[i]! += share })
  }

  let balance = principalCents
  const schedule: ScheduleRowOut[] = principal.map((principalDue, i) => {
    const row: ScheduleRowOut = {
      installmentNo: i + 1,
      dueDate: dueDates[i]!,
      principalDue,
      interestDue: interest[i]!,
      feesDue: fees[i]!,
      totalDue: principalDue + interest[i]! + fees[i]!,
      openingBalance: balance,
      closingBalance: balance - principalDue,
    }
    balance -= principalDue
    return row
  })
  // A period that owes nothing (a principal-only grace on an interest-free loan with no fee) is not an instalment.
  const owed = schedule.filter((row) => row.totalDue > 0).map((row, i) => ({ ...row, installmentNo: i + 1 }))
  return {
    schedule: owed,
    totalInterest: interest.reduce((a, b) => a + b, 0),
    serviceFees: fees.reduce((a, b) => a + b, 0),
    deferredInterest: deferred,
  }
}
