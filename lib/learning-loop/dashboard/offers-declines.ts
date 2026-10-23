/**
 * Offer take-up and decline volume (DESIGN.md §5-§6). Pure.
 *
 * Take-up: an offer's TAKEN_UP row (window OFFER); false is NOT_TAKEN_UP.
 * Declines carry no outcome (nothing is repaid), so they are counted by
 * category only, beside the cohorts, to show who the outcome rates leave out.
 * Refusals the code made alone (actorType SYSTEM: the portal and website
 * submission refusals, lib/learning-loop/submission-refusal.ts) are not staff
 * declines: they are counted apart, by reason, with how many await the
 * lender's POPIA s71 legal review, a go-live gate (DESIGN.md decision 5, §7).
 */
import { SMALL_CELL_LOANS, groupBy, tally, type OutcomeRow, type Tally } from "./cells"

export interface OfferInput {
  /** SAST `yyyy-mm` of the offer. */
  month: string
  /** APPROVED_TERMS or QUOTATION_ISSUED. */
  decision: string
  outcomes: readonly OutcomeRow[]
}

export interface TakeUpCell {
  month: string
  decision: string
  offers: number
  small: boolean
  takeUp: Tally
}

export function offerTakeUp(offers: readonly OfferInput[]): TakeUpCell[] {
  const groups = groupBy(offers, (o) => `${o.month}|${o.decision}`)
  return [...groups.values()].map((group) => ({
    month: group[0].month, decision: group[0].decision, offers: group.length, small: group.length < SMALL_CELL_LOANS,
    takeUp: tally(group.map((o) => o.outcomes), "TAKEN_UP", "OFFER"),
  })).sort((a, b) => b.month.localeCompare(a.month) || a.decision.localeCompare(b.decision))
}

/** A decline record with no category (an asset-finance decline records none). */
export const UNCATEGORISED = "UNCATEGORISED"

export interface DeclineInput {
  month: string
  /** inputsSnapshot.declineCategory, or null. */
  category: string | null
  actorType: "STAFF" | "SYSTEM" | "CLIENT"
  /** inputsSnapshot.refusalReason of an automated refusal, or null. */
  refusalReason: string | null
  s71ReviewRequired: boolean
}

export interface DeclineCell {
  month: string
  category: string
  declines: number
}

export interface AutomatedRefusals {
  /** Declines recorded with actorType SYSTEM. */
  total: number
  /** Of those, flagged for the lender's POPIA s71 legal review. */
  s71ReviewRequired: number
  byReason: Record<string, number>
}

export interface DeclineSummary {
  /** Staff declines only (an automated refusal is not a staff decline). */
  cells: DeclineCell[]
  total: number
  byCategory: Record<string, number>
  automated: AutomatedRefusals
}

export function declineVolume(all: readonly DeclineInput[]): DeclineSummary {
  const declines = all.filter((d) => d.actorType !== "SYSTEM")
  const refusals = all.filter((d) => d.actorType === "SYSTEM")
  const category = (d: DeclineInput) => d.category ?? UNCATEGORISED
  const groups = groupBy(declines, (d) => `${d.month}|${category(d)}`)
  const byCategory: Record<string, number> = {}
  for (const d of declines) byCategory[category(d)] = (byCategory[category(d)] ?? 0) + 1
  const byReason: Record<string, number> = {}
  for (const r of refusals) byReason[r.refusalReason ?? UNCATEGORISED] = (byReason[r.refusalReason ?? UNCATEGORISED] ?? 0) + 1
  return {
    cells: [...groups.values()]
      .map((g) => ({ month: g[0].month, category: category(g[0]), declines: g.length }))
      .sort((a, b) => b.month.localeCompare(a.month) || b.declines - a.declines || a.category.localeCompare(b.category)),
    total: declines.length,
    byCategory,
    automated: { total: refusals.length, s71ReviewRequired: refusals.filter((r) => r.s71ReviewRequired).length, byReason },
  }
}
