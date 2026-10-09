// Describing what the consumer actually pays, instalment by instalment.
//
// `calc.monthlyInstalment` is the LEVEL instalment — the amortisation figure.
// It is not always what the consumer is debited. Under a DEFERRED initiation
// fee the calculator adds the whole fee to the first row:
//
//   lib/loan-calculator.ts: schedule[0].feesDue += initiationFee
//
// so an R10,000 / 180-day loan whose "Monthly Instalment" reads R1,914.98 is
// really billed:
//
//   R2,994.98, R1,914.98, R1,914.98, R1,914.98, R1,914.98, R1,914.96
//
// A consumer budgeting R1,914.98 is R1,080 short in month one. Rounding also
// makes the final row differ by a cent or two. Both belong on the disclosure,
// so this derives the pattern from the SCHEDULE — the same rows that are
// billed — rather than from the level-instalment scalar.

import { recurringInstalmentDue } from "./instalment"

export type InstalmentPattern = {
  /** True when every instalment is the same amount. */
  uniform: boolean
  count: number
  /** Amount of the first instalment (carries the deferred initiation fee). */
  first: number
  /** The amount repeated in the middle of the schedule. */
  regular: number
  /** Final instalment — may differ by rounding cents. */
  last: number
}

export function describeInstalments(schedule: { totalDue: number }[]): InstalmentPattern {
  if (schedule.length === 0) {
    return { uniform: true, count: 0, first: 0, regular: 0, last: 0 }
  }
  const amounts = schedule.map((s) => s.totalDue)
  return {
    // `recurringInstalmentDue` is the authority on which row is the recurring
    // amount — it is already used by the client portal, so reusing it keeps the
    // signed agreement and the client's own loan page from disagreeing.
    //
    // Do NOT infer this by "most common amount": on a 3-row schedule the final
    // row differs by a rounding cent, so NO amount repeats, and a most-common
    // tally silently returns the fee-loaded FIRST instalment. That printed
    // "R4,684.30 x 2" on a 90-day personal loan whose second instalment is
    // R3,604.30 — overstating it by the whole initiation fee, on the signed
    // credit agreement.
    regular: recurringInstalmentDue(schedule),
    uniform: new Set(amounts).size === 1,
    count: amounts.length,
    first: amounts[0],
    last: amounts[amounts.length - 1],
  }
}

/**
 * Human-readable instalment disclosure. `fmt` is injected so each caller uses
 * its own money formatter — the PDF helpers, the nbsp display formatter, or the
 * plain-space SMS one — without this module picking the wrong channel.
 */
export function formatInstalmentPattern(
  p: InstalmentPattern,
  fmt: (cents: number) => string,
): string {
  if (p.count === 0) return "—"
  if (p.count === 1) return fmt(p.first)
  if (p.uniform) return `${fmt(p.regular)} x ${p.count}`

  // Every row must be accounted for exactly once: a named first, a repeated
  // middle, and a named final only when it genuinely differs. Deriving the
  // middle count by subtraction (rather than by decrementing conditionally)
  // is what guarantees the named payments sum to `count` — the amounts on this
  // line are legally binding, so a dropped or double-counted row is a defect.
  const firstDistinct = p.first !== p.regular
  const lastDistinct = p.last !== p.regular
  const repeats = p.count - (firstDistinct ? 1 : 0) - (lastDistinct ? 1 : 0)

  const parts: string[] = []
  if (firstDistinct) parts.push(`First ${fmt(p.first)}`)
  if (repeats > 0) {
    // "x 1" reads as an error to a consumer; name the amount plainly instead.
    const body = repeats === 1 ? fmt(p.regular) : `${fmt(p.regular)} x ${repeats}`
    parts.push(firstDistinct ? `then ${body}` : body)
  }
  if (lastDistinct) parts.push(`final ${fmt(p.last)}`)
  return parts.join(", ")
}
