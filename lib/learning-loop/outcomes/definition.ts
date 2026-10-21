/**
 * Outcome definitions, owned by code (docs/learning-loop/DESIGN.md §3). Every
 * function in this directory is pure: it reads source-neutral facts (a loan's
 * schedule, its daily arrears history, its returned debit orders) and returns
 * DecisionOutcome rows. A change to any definition bumps
 * OUTCOME_DEFINITION_VERSION; the next run recomputes every row.
 *
 * Days are SAST calendar dates, `yyyy-mm-dd`, as LoanArrearsSnapshot stores
 * them. A window is [start, end): `end` is the first day outside it.
 */
import type { DecisionOutcomeKind, DecisionOutcomeState } from "@prisma/client"

export const OUTCOME_DEFINITION_VERSION = "outcomes-v1"

export type SourceSystem = "credaflow" | "external_extract"

/** Months on book, counted from the first instalment due date. */
export const MONTH_WINDOWS = [
  { window: "3M", months: 3 },
  { window: "6M", months: 6 },
  { window: "12M", months: 12 },
] as const

/** Short loans also get term end + this many days. */
export const TERM_GRACE_DAYS = 30

export const DPD_THRESHOLDS = [
  { kind: "EVER_30_DPD", dpd: 30 },
  { kind: "EVER_60_DPD", dpd: 60 },
  { kind: "EVER_90_DPD", dpd: 90 },
] as const

/** Bad = ever 90+ DPD within 12 months (s129 eligibility and the 90+ report band). */
export const HEADLINE_BAD = { outcomeKind: "EVER_90_DPD", window: "12M" } as const

/** LATE: paid after the due date and before this many days past it. */
export const LATE_BEFORE_DPD = 30

/** Why a row is UNOBSERVABLE (DecisionOutcome.reasonCode). */
export const UNOBSERVABLE_REASONS = {
  HISTORY_GAP: "HISTORY_GAP",
  NO_SCHEDULE: "NO_SCHEDULE",
  PAID_AT_MISSING: "PAID_AT_MISSING",
  CLOSE_DATE_MISSING: "CLOSE_DATE_MISSING",
} as const

/** CURED's reasonCode when the loan never reached 30 DPD in the window (value false). */
export const NEVER_30_DPD = "NEVER_30_DPD"

/** One derived outcome, before the writer adds the tenant, source system and version. */
export interface DerivedOutcome {
  decisionRecordId: string
  outcomeKind: DecisionOutcomeKind
  window: string
  state: DecisionOutcomeState
  value: boolean | null
  amountCents: number | null
  reasonCode: string | null
  sourceRef: string
  observedAt: Date | null
}

export const observed = (value: boolean, observedAt: Date, extra: { amountCents?: number | null; reasonCode?: string | null } = {}) =>
  ({ state: "OBSERVED" as const, value, observedAt, amountCents: extra.amountCents ?? null, reasonCode: extra.reasonCode ?? null })
export const pending = (amountCents: number | null = null) =>
  ({ state: "PENDING" as const, value: null, observedAt: null, amountCents, reasonCode: null })
export const unobservable = (reasonCode: string, amountCents: number | null = null) =>
  ({ state: "UNOBSERVABLE" as const, value: null, observedAt: null, amountCents, reasonCode })

// ── Days ─────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

export function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) / DAY_MS
}

export function dayFromNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}

export const addDays = (day: string, days: number) => dayFromNumber(dayNumber(day) + days)

/** Calendar months later, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number)
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d, lastDay))
  return target.toISOString().slice(0, 10)
}

/** The instant an outcome dated by a SAST day is observed: that day's SAST midnight. */
export function dayInstant(day: string): Date {
  return new Date(`${day}T00:00:00.000+02:00`)
}
