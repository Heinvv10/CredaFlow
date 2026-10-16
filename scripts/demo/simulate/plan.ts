/**
 * The bake's storyline schedule: for every background persona (plus the
 * returning client's FIRST loan), when origination starts, where it parks,
 * and how the loan is serviced, so that on the end date each persona sits in
 * its storyline's target state.
 *
 * Anchors are relative to the window, never absolute dates:
 *   - `dbe`         disburse that many calendar days before `until`;
 *   - `missed`      disburse so instalment `row` falls due `dpd` days before
 *                   `until` (instalment n is due n months after payout), which
 *                   puts the loan ~dpd days past due on the end date;
 *   - `parkBiz`     start origination that many business days before the last
 *                   full business day, so a parked application is fresh.
 * Origination takes 3 business days to payout; a start that would fall before
 * the window is moved to the window's first business day (logged).
 */
import { PERSONAS, type Persona } from "../personas"
import type { OriginationStep } from "../scenarios/origination"
import { addDays, addMonths, nextBusinessDay, prevBusinessDay, shiftBusinessDays } from "./dates"

export type Channel = "DEBIT_ORDER" | "EFT_STATEMENT" | "EFT_STATEMENT_NO_REF" | "EFT_MANUAL"

export interface ServicingSpec {
  channel: Channel
  /** Instalments paid on time from the first; omitted = every instalment due by the end. */
  paidRows?: number
  /** This instalment's debit order is collected, then returned unpaid two business days later. */
  bounceRow?: number
  /** Early settlement via the certificate of balance, `daysAfter` instalment `afterRow` fell due. */
  settle?: { afterRow: number; daysAfter: number }
  /** Single-instalment loans: settled via the certificate of balance on the due date. */
  settleAtMaturity?: boolean
  /** SOFT_REMINDER 7 and FORMAL_REMINDER 21 days after the first missed instalment. */
  reminders?: boolean
  s129AtDpd?: number
  attorneyAfterBusinessDays?: number
  arrangement?: { atDpd: number; periods: number; withPlan?: boolean }
  writeOffAtDpd?: number
}

type Anchor = { dbe: number } | { missed: { row: number; dpd: number } } | { startDbe: number } | { parkBiz: number }

interface PlanSpec {
  id: string
  anchor: Anchor
  stopAfter?: OriginationStep
  draft?: boolean
  /** Cancel (applicant withdrew) this many business days after origination parked. */
  withdrawAfter?: number
  servicing?: ServicingSpec
  /** Replaces the persona's loan request (the returning client's smaller first loan). */
  loanRequest?: Persona["loanRequest"]
}

const DO: Channel = "DEBIT_ORDER"

const SPECS: readonly PlanSpec[] = [
  { id: "live-returning-client", anchor: { dbe: 182 }, loanRequest: { productCode: "PERSONAL", amountCents: 8_000_00, termDays: 180 },
    servicing: { channel: DO, paidRows: 2, settle: { afterRow: 2, daysAfter: 12 } } },
  // settled
  { id: "bg-04", anchor: { dbe: 175 }, servicing: { channel: "EFT_MANUAL", settleAtMaturity: true } },
  { id: "bg-05", anchor: { dbe: 140 }, servicing: { channel: "EFT_MANUAL", settleAtMaturity: true } },
  { id: "bg-06", anchor: { dbe: 105 }, servicing: { channel: "EFT_MANUAL", settleAtMaturity: true } },
  { id: "bg-07", anchor: { dbe: 178 }, servicing: { channel: "EFT_STATEMENT", paidRows: 3, settle: { afterRow: 3, daysAfter: 9 } } },
  { id: "bg-08", anchor: { dbe: 152 }, servicing: { channel: DO, paidRows: 4, settle: { afterRow: 4, daysAfter: 6 } } },
  { id: "bg-09", anchor: { dbe: 62 }, servicing: { channel: "EFT_MANUAL", settleAtMaturity: true } },
  // active
  { id: "bg-10", anchor: { dbe: 125 }, servicing: { channel: DO } },
  { id: "bg-11", anchor: { dbe: 165 }, servicing: { channel: "EFT_STATEMENT" } },
  { id: "bg-12", anchor: { dbe: 92 }, servicing: { channel: DO } },
  { id: "bg-13", anchor: { dbe: 22 }, servicing: { channel: DO } },
  { id: "bg-14", anchor: { dbe: 14 }, servicing: { channel: DO } },
  { id: "bg-15", anchor: { dbe: 7 }, servicing: { channel: DO } },
  { id: "bg-16", anchor: { dbe: 145 }, servicing: { channel: "EFT_STATEMENT_NO_REF" } },
  { id: "bg-17", anchor: { dbe: 48 }, servicing: { channel: DO } },
  // arrears
  { id: "bg-18", anchor: { missed: { row: 3, dpd: 29 } }, servicing: { channel: DO, paidRows: 2, bounceRow: 3, reminders: true } },
  { id: "bg-19", anchor: { missed: { row: 1, dpd: 30 } }, servicing: { channel: DO, paidRows: 0, reminders: true } },
  { id: "bg-20", anchor: { missed: { row: 2, dpd: 28 } }, servicing: { channel: DO, paidRows: 1, reminders: true } },
  { id: "bg-21", anchor: { missed: { row: 3, dpd: 59 } }, servicing: { channel: DO, paidRows: 2, reminders: true } },
  { id: "bg-22", anchor: { missed: { row: 2, dpd: 58 } }, servicing: { channel: DO, paidRows: 1, reminders: true } },
  { id: "bg-23", anchor: { missed: { row: 2, dpd: 89 } }, servicing: { channel: DO, paidRows: 1, reminders: true } },
  { id: "bg-24", anchor: { missed: { row: 3, dpd: 88 } }, servicing: { channel: DO, paidRows: 2, reminders: true } },
  // Section 129, attorney
  { id: "bg-25", anchor: { missed: { row: 2, dpd: 122 } }, servicing: { channel: DO, paidRows: 1, reminders: true, s129AtDpd: 95 } },
  { id: "bg-26", anchor: { missed: { row: 1, dpd: 125 } },
    servicing: { channel: DO, paidRows: 0, reminders: true, s129AtDpd: 93, attorneyAfterBusinessDays: 12 } },
  // payment arrangement with resumed payments
  // Anchored on the missed instalment, like the arrears storylines: the
  // arrangement starts ~75 days before the end, so three of its four payments
  // land in the window and the last after it, whatever the end date.
  { id: "bg-27", anchor: { missed: { row: 2, dpd: 111 } }, servicing: { channel: DO, paidRows: 1, reminders: true, arrangement: { atDpd: 36, periods: 4 } } },
  { id: "bg-28", anchor: { dbe: 178 },
    servicing: { channel: DO, paidRows: 2, reminders: true, arrangement: { atDpd: 35, periods: 6, withPlan: true } } },
  // written off
  { id: "bg-29", anchor: { missed: { row: 2, dpd: 122 } }, servicing: { channel: DO, paidRows: 1, reminders: true, s129AtDpd: 92, writeOffAtDpd: 110 } },
  { id: "bg-30", anchor: { dbe: 186 }, servicing: { channel: DO, paidRows: 0, reminders: true, writeOffAtDpd: 100 } },
  // ended without a loan
  { id: "bg-31", anchor: { startDbe: 168 } },
  { id: "bg-32", anchor: { startDbe: 112 } },
  { id: "bg-33", anchor: { startDbe: 71 } },
  { id: "bg-34", anchor: { startDbe: 26 } },
  { id: "bg-35", anchor: { startDbe: 133 }, stopAfter: "bureau", withdrawAfter: 4 },
  { id: "bg-36", anchor: { startDbe: 52 }, stopAfter: "capture", withdrawAfter: 2 },
  // parked mid-origination
  { id: "bg-37", anchor: { parkBiz: 6 }, draft: true },
  { id: "bg-38", anchor: { parkBiz: 2 }, draft: true },
  { id: "bg-39", anchor: { parkBiz: 5 }, stopAfter: "capture" },
  { id: "bg-40", anchor: { parkBiz: 1 }, stopAfter: "capture" },
  { id: "bg-41", anchor: { parkBiz: 8 }, stopAfter: "affordability" },
  { id: "bg-42", anchor: { parkBiz: 4 }, stopAfter: "affordability" },
  { id: "bg-43", anchor: { parkBiz: 6 }, stopAfter: "decision" },
  { id: "bg-44", anchor: { parkBiz: 2 }, stopAfter: "pasq" },
  { id: "bg-45", anchor: { parkBiz: 3 }, stopAfter: "mandate" },
]

export interface PersonaPlan {
  persona: Persona
  originationStart: string
  stopAfter?: OriginationStep
  draft?: boolean
  withdrawAfter?: number
  servicing?: ServicingSpec
  /** Why the start moved, when it did. */
  note?: string
}

export interface Window {
  /** First simulated day (YYYY-MM-DD). */
  start: string
  /** Last simulated day; DPD targets are measured on it. */
  until: string
  /** Last business day whose business hours are fully simulated. */
  lastBusinessDay: string
}

/** Origination day 0 for a target payout day: three business days earlier. */
const startForPayout = (payout: string): string => shiftBusinessDays(prevBusinessDay(payout), -3)

function startFor(anchor: Anchor, w: Window): string {
  if ("dbe" in anchor) return startForPayout(addDays(w.until, -anchor.dbe))
  if ("missed" in anchor) return startForPayout(addMonths(addDays(w.until, -anchor.missed.dpd), -anchor.missed.row))
  if ("startDbe" in anchor) return nextBusinessDay(addDays(w.until, -anchor.startDbe))
  return shiftBusinessDays(w.lastBusinessDay, -anchor.parkBiz)
}

/**
 * The days an arrangement storyline's payments fall due, from the plan alone:
 * payout three business days after origination starts, instalment n due n
 * months after payout, the arrangement `atDpd` days after the first missed
 * instalment, one payment a month. null when the plan has no arrangement.
 */
export function arrangementDays(plan: PersonaPlan): string[] | null {
  const a = plan.servicing?.arrangement
  if (!a) return null
  const firstMissed = addMonths(shiftBusinessDays(plan.originationStart, 3), (plan.servicing?.paidRows ?? 0) + 1)
  const start = nextBusinessDay(addDays(firstMissed, a.atDpd))
  return Array.from({ length: a.periods }, (_, k) => nextBusinessDay(addMonths(start, k)))
}

export function buildPlans(w: Window): PersonaPlan[] {
  const firstStart = nextBusinessDay(w.start)
  const plans = SPECS.map((spec): PersonaPlan => {
    const base = PERSONAS.find((p) => p.id === spec.id)
    if (!base) throw new Error(`plan names unknown persona ${spec.id}`)
    const persona = spec.loanRequest ? { ...base, loanRequest: spec.loanRequest } : base
    let originationStart = startFor(spec.anchor, w)
    let note: string | undefined
    if (originationStart < firstStart) {
      note = `start ${originationStart} is before the window; moved to ${firstStart}`
      originationStart = firstStart
    }
    return {
      persona,
      originationStart,
      stopAfter: spec.stopAfter,
      draft: spec.draft,
      withdrawAfter: spec.withdrawAfter,
      servicing: spec.servicing,
      note,
    }
  })
  const unplanned = PERSONAS.filter((p) => p.kind === "background" && !plans.some((x) => x.persona.id === p.id))
  if (unplanned.length > 0) throw new Error(`background personas without a plan: ${unplanned.map((p) => p.id).join(", ")}`)
  return plans.sort((a, b) => a.originationStart.localeCompare(b.originationStart))
}
