/**
 * Months-on-book outcomes (DESIGN.md §3) from the daily arrears history:
 * EVER_30/60/90_DPD, CURED, DEFAULTED_STATUS, plus SETTLED and WRITTEN_OFF
 * from how the loan ended. Windows 3M, 6M and 12M from the first instalment
 * due day, and TERM_30D (term end + 30 days) for a short loan: one whose
 * term end + 30 days falls inside the 3M window.
 *
 * A window is PENDING until it has elapsed, even when the event already
 * happened inside it: an immature cohort would otherwise show only its bads.
 * Once elapsed, an event seen in the history is OBSERVED true; "it did not
 * happen" is OBSERVED false only when every day the loan was open in the
 * window has a recorded position. A missing day makes it UNOBSERVABLE
 * (HISTORY_OUTAGE when the lender had no nightly run that day, HISTORY_GAP
 * otherwise): the history starts at the first nightly run and is never
 * backfilled, so a gap is never read as good.
 *
 * A loan written off inside the window before reaching a DPD threshold has
 * that threshold true (WRITTEN_OFF_BEFORE_THRESHOLD): a write-off is a loss.
 * A loan cancelled (cooling-off) inside the window never performed: its
 * not-seen events are UNOBSERVABLE (LOAN_CANCELLED), never good.
 */
import type { DecisionOutcomeKind } from "@prisma/client"
import type { ArrearsDayFact, LoanFacts } from "./facts"
import {
  MONTH_WINDOWS, NEVER_30_DPD, TERM_GRACE_DAYS, UNOBSERVABLE_REASONS, WRITTEN_OFF_BEFORE_THRESHOLD,
  addDays, addMonths, dayFromNumber, dayInstant, dayNumber, observed, pending, unobservable, windowThresholds, type DerivedOutcome,
} from "./definition"

type Row = Omit<DerivedOutcome, "decisionRecordId">

export interface OutcomeWindow {
  window: string
  start: string
  /** The first day outside the window. */
  end: string
}

/** The windows a loan is measured over; empty without a schedule (no first due day). */
export function loanWindows(facts: Pick<LoanFacts, "instalments" | "maturityDay">): OutcomeWindow[] {
  const first = facts.instalments[0]?.dueDay
  if (!first) return []
  const windows: OutcomeWindow[] = MONTH_WINDOWS.map((w) => ({ window: w.window, start: first, end: addMonths(first, w.months) }))
  const termEnd = addDays(facts.maturityDay, TERM_GRACE_DAYS)
  if (dayNumber(termEnd) < dayNumber(windows[0].end)) windows.push({ window: "TERM_30D", start: first, end: termEnd })
  return windows
}

type Coverage = { complete: true } | { complete: false; reason: string }

/** Whether every day the loan was open in the window has a recorded position. */
function coverage(facts: LoanFacts, w: OutcomeWindow, recorded: Set<string>): Coverage {
  if (facts.end.kind !== "OPEN" && facts.end.day === null) return { complete: false, reason: UNOBSERVABLE_REASONS.CLOSE_DATE_MISSING }
  // A closed loan has no position from its close day on (it left the collectible book).
  const until = facts.end.kind === "OPEN" ? dayNumber(w.end) : Math.min(dayNumber(w.end), dayNumber(facts.end.day as string))
  let gap: Coverage | null = null
  for (let d = dayNumber(w.start); d < until; d++) {
    const day = dayFromNumber(d)
    if (recorded.has(day)) continue
    if (facts.sourceRecordedDays && !facts.sourceRecordedDays.has(day)) return { complete: false, reason: UNOBSERVABLE_REASONS.HISTORY_OUTAGE }
    gap ??= { complete: false, reason: UNOBSERVABLE_REASONS.HISTORY_GAP }
  }
  return gap ?? { complete: true }
}

/** Ended inside the window (before its first day outside). */
function endedIn(facts: LoanFacts, kind: "WRITTEN_OFF" | "CANCELLED", w: OutcomeWindow): string | null {
  return facts.end.kind === kind && facts.end.day !== null && dayNumber(facts.end.day) < dayNumber(w.end) ? facts.end.day : null
}

function inWindow(history: readonly ArrearsDayFact[], w: OutcomeWindow): ArrearsDayFact[] {
  const s = dayNumber(w.start), e = dayNumber(w.end)
  return history.filter((h) => { const d = dayNumber(h.day); return d >= s && d < e }).sort((a, b) => a.day.localeCompare(b.day))
}

/** An event seen in the window, or proof (complete history) that it did not happen. */
function eventOutcome(kind: DecisionOutcomeKind, facts: LoanFacts, w: OutcomeWindow, cov: Coverage, hit: ArrearsDayFact | undefined, dpdThreshold = false): Row {
  const base = { outcomeKind: kind, window: w.window, sourceRef: facts.ref }
  if (hit) return { ...base, ...observed(true, dayInstant(hit.day)) }
  const writtenOff = dpdThreshold ? endedIn(facts, "WRITTEN_OFF", w) : null
  if (writtenOff) return { ...base, ...observed(true, dayInstant(writtenOff), { reasonCode: WRITTEN_OFF_BEFORE_THRESHOLD }) }
  if (endedIn(facts, "CANCELLED", w)) return { ...base, ...unobservable(UNOBSERVABLE_REASONS.LOAN_CANCELLED) }
  if (!cov.complete) return { ...base, ...unobservable(cov.reason) }
  return { ...base, ...observed(false, dayInstant(w.end)) }
}

/** CURED: back to 0 DPD (or settled) after reaching 30+ DPD in the window. */
function curedOutcome(facts: LoanFacts, w: OutcomeWindow, cov: Coverage, rows: ArrearsDayFact[]): Row {
  const base = { outcomeKind: "CURED" as const, window: w.window, sourceRef: facts.ref }
  const delinquentAt = rows.findIndex((r) => r.daysInArrears >= 30)
  if (delinquentAt >= 0) {
    const back = rows.slice(delinquentAt + 1).find((r) => r.daysInArrears === 0)
    if (back) return { ...base, ...observed(true, dayInstant(back.day)) }
    const settled = facts.end.kind === "SETTLED" && facts.end.day !== null && dayNumber(facts.end.day) < dayNumber(w.end) ? facts.end.day : null
    if (settled) return { ...base, ...observed(true, dayInstant(settled)) }
  }
  if (endedIn(facts, "CANCELLED", w)) return { ...base, ...unobservable(UNOBSERVABLE_REASONS.LOAN_CANCELLED) }
  if (!cov.complete) return { ...base, ...unobservable(cov.reason) }
  return { ...base, ...observed(false, dayInstant(w.end), { reasonCode: delinquentAt >= 0 ? null : NEVER_30_DPD }) }
}

/** SETTLED / WRITTEN_OFF: the loan ended that way before the window closed. */
function endedOutcome(kind: "SETTLED" | "WRITTEN_OFF", facts: LoanFacts, w: OutcomeWindow): Row {
  const base = { outcomeKind: kind, window: w.window, sourceRef: facts.ref }
  if (facts.end.kind === kind) {
    if (facts.end.day === null) return { ...base, ...unobservable(UNOBSERVABLE_REASONS.CLOSE_DATE_MISSING) }
    if (dayNumber(facts.end.day) < dayNumber(w.end)) return { ...base, ...observed(true, dayInstant(facts.end.day)) }
  }
  return { ...base, ...observed(false, dayInstant(w.end)) }
}

const windowKinds = (window: string): DecisionOutcomeKind[] =>
  [...windowThresholds(window).map((t) => t.kind), "CURED", "DEFAULTED_STATUS", "SETTLED", "WRITTEN_OFF"]

export function windowOutcomes(facts: LoanFacts, today: string): Row[] {
  const windows = loanWindows(facts)
  if (windows.length === 0) {
    return MONTH_WINDOWS.flatMap((w) => windowKinds(w.window).map((kind) => ({
      outcomeKind: kind, window: w.window, sourceRef: facts.ref, ...unobservable(UNOBSERVABLE_REASONS.NO_SCHEDULE),
    })))
  }
  const recorded = new Set(facts.arrearsHistory.map((h) => h.day))
  return windows.flatMap((w) => {
    if (dayNumber(today) < dayNumber(w.end)) return windowKinds(w.window).map((kind) => ({ outcomeKind: kind, window: w.window, sourceRef: facts.ref, ...pending() }))
    const rows = inWindow(facts.arrearsHistory, w)
    const cov = coverage(facts, w, recorded)
    return [
      ...windowThresholds(w.window).map((t) => eventOutcome(t.kind, facts, w, cov, rows.find((r) => r.daysInArrears >= t.dpd), true)),
      curedOutcome(facts, w, cov, rows),
      eventOutcome("DEFAULTED_STATUS", facts, w, cov, rows.find((r) => r.defaulted)),
      endedOutcome("SETTLED", facts, w),
      endedOutcome("WRITTEN_OFF", facts, w),
    ]
  })
}
