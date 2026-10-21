/**
 * Collections panel (DESIGN.md §6). Pure. DESCRIPTIVE, NOT CAUSAL: there is no
 * holdout or variant, so a difference between stages reflects which loans
 * reached them as much as what the stage did.
 *
 * Built only from data that exists:
 * - Cure and roll by collections stage, from the daily arrears history
 *   (LoanArrearsSnapshot). An episode starts on a day the loan is past due
 *   and either was not the day before or was at another stage. The first
 *   day read starts none (the day before it is unknown), and none starts at
 *   stage WRITTEN_OFF or on or after the day the loan ended. Within the
 *   next HORIZON_DAYS it is CURED (back to 0 DPD, or settled), ROLLED (into a
 *   later ARREARS_BANDS band, lib/reports/arrears-buckets.ts, or written off),
 *   whichever comes first; otherwise STAYED once the horizon has elapsed with
 *   every open day recorded, PENDING before that, UNOBSERVABLE when a day is
 *   missing or the loan was cancelled inside the horizon (never read as
 *   stayed or cured).
 * - Arrangement kept / broken, from PaymentArrangement.status as
 *   lib/collections/arrangement-check.ts sets it (one row per loan: an
 *   earlier arrangement's result is overwritten by the next).
 * Collection actions (reminders, s129, calls) are not logged yet (DESIGN.md
 * §2.5), so there is no by-action view.
 */
import type { CollectionsStage } from "@prisma/client"
import { arrearsBucket, ARREARS_BANDS } from "@/lib/reports/arrears-buckets"
import { addDays, dayNumber } from "../outcomes/definition"
import { SMALL_CELL_LOANS, pct } from "./cells"

export const HORIZON_DAYS = 30

export interface HistoryDay {
  /** SAST `yyyy-mm-dd`. */
  day: string
  daysInArrears: number
  stage: CollectionsStage
}

export interface LoanHistory {
  loanId: string
  days: readonly HistoryDay[]
  /** How the loan ended; `day` null when the end has no date. */
  end: { kind: "OPEN" | "SETTLED" | "WRITTEN_OFF" | "CANCELLED"; day: string | null }
}

export type EpisodeResult = "CURED" | "ROLLED" | "STAYED" | "PENDING" | "UNOBSERVABLE"

export interface Episode {
  loanId: string
  stage: CollectionsStage
  startDay: string
  result: EpisodeResult
}

const bandIndex = (dpd: number) => ARREARS_BANDS.findIndex((b) => b.label === arrearsBucket(dpd))

/** Every stage episode of one loan, judged as of `today` (SAST `yyyy-mm-dd`). */
export function stageEpisodes(loan: LoanHistory, today: string): Episode[] {
  const days = [...loan.days].sort((a, b) => a.day.localeCompare(b.day))
  const byDay = new Map(days.map((d) => [d.day, d]))
  const episodes: Episode[] = []
  const ended = loan.end.kind !== "OPEN" ? loan.end.day : null
  days.forEach((d, i) => {
    const prev = i > 0 ? days[i - 1] : null
    if (!prev || d.daysInArrears <= 0 || d.stage === "WRITTEN_OFF") return
    if (ended !== null && d.day >= ended) return
    if (prev.daysInArrears > 0 && prev.stage === d.stage) return
    episodes.push({ loanId: loan.loanId, stage: d.stage, startDay: d.day, result: judge(d, byDay, loan.end, today) })
  })
  return episodes
}

function judge(start: HistoryDay, byDay: Map<string, HistoryDay>, end: LoanHistory["end"], today: string): EpisodeResult {
  const startBand = bandIndex(start.daysInArrears)
  const horizonEnd = addDays(start.day, HORIZON_DAYS)
  const endDay = end.kind !== "OPEN" && end.day !== null && end.day > start.day && end.day <= horizonEnd ? end.day : null
  let gap = false
  for (let k = 1; k <= HORIZON_DAYS; k++) {
    const day = addDays(start.day, k)
    if (endDay !== null && day >= endDay) {
      if (end.kind === "SETTLED") return "CURED"
      if (end.kind === "WRITTEN_OFF") return "ROLLED"
      // CANCELLED: never performed (as DESIGN.md §3 treats it), not stayed.
      return "UNOBSERVABLE"
    }
    const row = byDay.get(day)
    if (!row) { gap = true; continue }
    if (row.daysInArrears <= 0) return "CURED"
    if (bandIndex(row.daysInArrears) > startBand) return "ROLLED"
  }
  if (dayNumber(today) <= dayNumber(horizonEnd)) return "PENDING"
  return gap ? "UNOBSERVABLE" : "STAYED"
}

export interface StageCell {
  stage: CollectionsStage
  episodes: number
  loans: number
  small: boolean
  cured: number
  rolled: number
  stayed: number
  pending: number
  unobservable: number
  /** cured ÷ (cured + rolled + stayed), 0..100; null when none resolved. */
  cureRatePct: number | null
  rollRatePct: number | null
}

export function cureRollByStage(loans: readonly LoanHistory[], today: string): StageCell[] {
  const cells = new Map<CollectionsStage, StageCell & { loanIds: Set<string> }>()
  for (const loan of loans) {
    for (const e of stageEpisodes(loan, today)) {
      const cell = cells.get(e.stage) ?? {
        stage: e.stage, episodes: 0, loans: 0, small: true, cured: 0, rolled: 0, stayed: 0, pending: 0, unobservable: 0,
        cureRatePct: null, rollRatePct: null, loanIds: new Set<string>(),
      }
      cells.set(e.stage, cell)
      cell.episodes++
      cell.loanIds.add(e.loanId)
      if (e.result === "CURED") cell.cured++
      else if (e.result === "ROLLED") cell.rolled++
      else if (e.result === "STAYED") cell.stayed++
      else if (e.result === "PENDING") cell.pending++
      else cell.unobservable++
    }
  }
  return [...cells.values()].map(({ loanIds, ...c }) => {
    const resolved = c.cured + c.rolled + c.stayed
    return {
      ...c, loans: loanIds.size, small: loanIds.size < SMALL_CELL_LOANS,
      cureRatePct: pct(c.cured, resolved), rollRatePct: pct(c.rolled, resolved),
    }
  }).sort((a, b) => a.stage.localeCompare(b.stage))
}

export interface ArrangementSummary {
  total: number
  small: boolean
  active: number
  kept: number
  /** Ran to its end with under 90% paid (arrangement-check's COMPLETED): neither kept nor broken. */
  completedShort: number
  broken: number
  other: number
  /** kept ÷ (kept + completedShort + broken), 0..100. */
  keptRatePct: number | null
  brokenRatePct: number | null
}

/** From the number of arrangements per status. */
export function arrangementOutcomes(byStatus: Readonly<Record<string, number>>): ArrangementSummary {
  const count = (s: string) => byStatus[s] ?? 0
  const total = Object.values(byStatus).reduce((n, c) => n + c, 0)
  const [active, kept, completedShort, broken] = ["ACTIVE", "KEPT", "COMPLETED", "BROKEN"].map(count)
  const ended = kept + completedShort + broken
  return {
    total, small: total < SMALL_CELL_LOANS,
    active, kept, completedShort, broken, other: total - active - ended,
    keptRatePct: pct(kept, ended), brokenRatePct: pct(broken, ended),
  }
}
