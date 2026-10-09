import { SAST_TIME_ZONE } from "@/lib/utils"

/**
 * The `metadata.lastDecision` blob that PATCH /api/agent-hub/referral-events/[id]
 * writes on every decision, narrowed to what the queue displays.
 *
 * `byUserId` is deliberately left behind: it is an internal id with nothing to
 * say to a reviewer, and this shape crosses to a client component — the loader
 * must surface named fields, never the raw metadata jsonb.
 */
export type LastDecision = {
  commissionStatus: string | null
  qualityFlag: string | null
  note: string | null
  byEmail: string | null
  at: string | null
}

// metadata is jsonb: every field here is whatever was written, of whatever
// type. A non-string, or a string that is only whitespace, carries no
// information and must degrade to null rather than render as "undefined".
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null)

/**
 * Returns null when nothing recorded a decision on this row. A `lastDecision`
 * that isn't a plain object counts as nothing: a decision is a claim that a
 * named person withheld or released money, and garbage is not evidence one
 * happened.
 */
export function parseLastDecision(metadata: unknown): LastDecision | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null
  const last = (metadata as Record<string, unknown>).lastDecision
  if (!last || typeof last !== "object" || Array.isArray(last)) return null
  const value = last as Record<string, unknown>
  return {
    commissionStatus: str(value.commissionStatus),
    qualityFlag: str(value.qualityFlag),
    note: str(value.note),
    byEmail: str(value.byEmail),
    at: str(value.at),
  }
}

// A Map, not a Record: commissionStatus arrives from jsonb, so an object
// lookup would resolve "constructor" or "toString" off Object.prototype and
// render a function body as the verb.
const VERBS = new Map([
  ["PAYABLE", "Marked payable"],
  ["BLOCKED", "Blocked"],
  ["REVERSED", "Reversed"],
])

/**
 * Past tense, matching the button the reviewer pressed. An allow-list: an
 * unrecognised status degrades to the neutral "Decided" rather than describing
 * the decision with a word nobody chose.
 */
export function decisionVerb(decision: LastDecision): string {
  // Review writes commissionStatus back to PENDING with MANUAL_REVIEW, so the
  // status alone cannot tell a review apart from an untouched row.
  if (decision.commissionStatus === "PENDING") {
    return decision.qualityFlag === "MANUAL_REVIEW" ? "Sent for review" : "Decided"
  }
  return VERBS.get(decision.commissionStatus ?? "") ?? "Decided"
}

/**
 * "07 Aug 09:14" in SAST. The zone is pinned rather than left to the runtime
 * for the reason in lib/utils.ts: a UTC server and an SAST browser would
 * otherwise render the same instant as different text, both hydration-mismatching
 * and — on a compliance surface — misstating when someone decided.
 */
export function formatDecidedAt(at: string | null): string | null {
  if (!at) return null
  const date = new Date(at)
  // `new Date("nonsense")` is an Invalid Date whose toLocale* returns the
  // literal string "Invalid Date". Nothing is better than that.
  if (Number.isNaN(date.getTime())) return null
  const day = date.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE, day: "2-digit", month: "short" })
  const time = date.toLocaleTimeString("en-ZA", { timeZone: SAST_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false })
  return `${day} ${time}`
}

/**
 * One line for a queue row that already carries a decision, e.g.
 * "Blocked 07 Aug 09:14 by ops@example.com — Duplicate referral".
 *
 * Every segment after the verb is optional and omitted when absent: a line
 * reading "Blocked 07 Aug 09:14" states only what is known, where
 * "Blocked 07 Aug 09:14 by " would imply a missing actor.
 */
export function formatDecidedLine(decision: LastDecision): string {
  const parts = [decisionVerb(decision)]
  const at = formatDecidedAt(decision.at)
  if (at) parts.push(at)
  if (decision.byEmail) parts.push(`by ${decision.byEmail}`)
  const head = parts.join(" ")
  return decision.note ? `${head} — ${decision.note}` : head
}
