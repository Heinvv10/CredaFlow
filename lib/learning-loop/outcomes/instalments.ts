/**
 * Per-instalment outcomes (DESIGN.md §3): PAID by the due date, LATE (paid
 * after it, before 30 DPD), and each RETURNED_DEBIT_ORDER. Window
 * `INSTALMENT:<n>`, sourceRef the schedule row (or the collection result).
 */
import type { InstalmentFact, ReturnedDebitOrderFact } from "./facts"
import {
  LATE_BEFORE_DPD, UNOBSERVABLE_REASONS, addDays, dayInstant, dayNumber, observed, pending, unobservable,
  type DerivedOutcome,
} from "./definition"

type Row = Omit<DerivedOutcome, "decisionRecordId">

const instalmentWindow = (n: number) => `INSTALMENT:${n}`

/** PAID: settled in full on or before its due day. Known the day after the due day. */
export function paidOutcome(inst: InstalmentFact, today: string): Row {
  const base = { outcomeKind: "PAID" as const, window: instalmentWindow(inst.installmentNo), sourceRef: inst.ref }
  if (dayNumber(today) <= dayNumber(inst.dueDay)) return { ...base, ...pending(inst.totalDueCents) }
  if (inst.paidInFull && inst.paidDay === null) return { ...base, ...unobservable(UNOBSERVABLE_REASONS.PAID_AT_MISSING, inst.totalDueCents) }
  const onTime = inst.paidInFull && inst.paidDay !== null && dayNumber(inst.paidDay) <= dayNumber(inst.dueDay)
  const at = onTime ? dayInstant(inst.paidDay as string) : dayInstant(addDays(inst.dueDay, 1))
  return { ...base, ...observed(onTime, at, { amountCents: inst.totalDueCents }) }
}

/**
 * LATE: paid in full 1 to 29 days after the due day. Known once 30 days have
 * passed; an instalment paid on time, at 30+ DPD or not at all is not late
 * (the 30+ case is EVER_30_DPD's).
 */
export function lateOutcome(inst: InstalmentFact, today: string): Row {
  const base = { outcomeKind: "LATE" as const, window: instalmentWindow(inst.installmentNo), sourceRef: inst.ref }
  const windowEnd = addDays(inst.dueDay, LATE_BEFORE_DPD)
  if (dayNumber(today) < dayNumber(windowEnd)) return { ...base, ...pending(inst.totalDueCents) }
  if (inst.paidInFull && inst.paidDay === null) return { ...base, ...unobservable(UNOBSERVABLE_REASONS.PAID_AT_MISSING, inst.totalDueCents) }
  const daysLate = inst.paidInFull && inst.paidDay !== null ? dayNumber(inst.paidDay) - dayNumber(inst.dueDay) : null
  const late = daysLate !== null && daysLate >= 1 && daysLate < LATE_BEFORE_DPD
  const at = daysLate !== null && daysLate < LATE_BEFORE_DPD ? dayInstant(inst.paidDay as string) : dayInstant(windowEnd)
  return { ...base, ...observed(late, at, { amountCents: inst.totalDueCents }) }
}

/** One row per returned debit order, with its reason code exactly as the provider normalised it. */
export function returnedDebitOrderOutcome(ret: ReturnedDebitOrderFact): Row {
  return {
    outcomeKind: "RETURNED_DEBIT_ORDER",
    window: instalmentWindow(ret.installmentNo),
    sourceRef: ret.ref,
    ...observed(true, ret.resolvedAt, { amountCents: ret.amountCents, reasonCode: ret.reasonCode }),
  }
}
