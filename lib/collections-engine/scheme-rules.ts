/**
 * DebiCheck / debit-order SCHEME RULES — the one place they live.
 *
 * These are compliance boundaries, not tuning knobs, and they are enforced in
 * the engine, never in an adapter (lib/integrations/.claude.md). They are
 * written from the published DebiCheck scheme summaries, NOT from a provider's
 * signed rulebook: every value below MUST be verified against the sponsoring
 * provider's rulebook (Netcash first) before a lender goes live.
 *
 * The presentment cap and the tracking window are also enforced by the
 * database (migration 20261014150000_collections_engine); change both together
 * (lib/collections-engine/migration.test.ts holds them in step).
 */
import type { CollectionInstructionStatus } from "@prisma/client"
import type { NormalizedReason } from "@/lib/integrations/collections/types"

/** Scheme rule: an instalment is presented at most twice per collection cycle. DB: CollectionInstruction_presentment_cap. */
export const MAX_PRESENTMENTS_PER_CYCLE = 2

/** Scheme rule: after this many consecutive NPF unpaids the mandate is withdrawn (suspended) until a fresh mandate is authorised. */
export const CONSECUTIVE_NPF_LIMIT = 2

/** Scheme rule: the bank may track the debtor's account for funds for 1–10 days after the action date. DB: *_tracking_days. */
export const MIN_TRACKING_DAYS = 1
export const MAX_TRACKING_DAYS = 10

/** Scheme rule: a mandate's maximum collection amount may be at most 1.5 times the instalment amount. */
export const MAX_COLLECTION_AMOUNT_MULTIPLE = 1.5

/** Provider rule (two-day service): a batch is submitted at least this many business days before its action date. */
export const SUBMISSION_LEAD_BUSINESS_DAYS = 2

/** Engine policy, not a scheme rule: how far ahead instructions are planned and shown to staff. */
export const PLANNING_HORIZON_DAYS = 14

/** Engine policy: how far back results are requested (disputes arrive weeks after a debit). */
export const RESULT_LOOKBACK_DAYS = 45

/** Every mandate is registered as VARIABLE: the engine collects what is outstanding, up to the maximum. */
export const MANDATE_AMOUNT_TYPE = "VARIABLE" as const

/** "Not provided for": the unpaid reason the NPF rule counts. */
export const NPF_REASON: NormalizedReason = "INSUFFICIENT_FUNDS"

/** Unpaid reasons that end collection on the mandate at once: re-presenting cannot succeed. */
export const HARD_STOP_REASONS: readonly NormalizedReason[] = [
  "ACCOUNT_CLOSED",
  "PAYMENT_STOPPED",
  "MANDATE_SUSPENDED",
  "MANDATE_CANCELLED",
  "ACCOUNT_FROZEN",
  "NO_DEBIT_FACILITY",
]

export interface ResultFact {
  outcome: "PAID" | "UNPAID" | "DISPUTED"
  reasonCode: NormalizedReason | null
  resolvedAt: Date
}

export interface PresentmentFact {
  presentmentNo: number
  status: CollectionInstructionStatus
  /** The reason on the instruction's latest result, if any. */
  reasonCode: NormalizedReason | null
}

const isNpf = (r: ResultFact) => r.outcome === "UNPAID" && r.reasonCode === NPF_REASON

/** Length of the unbroken run of NPF unpaids ending at the newest result. */
export function consecutiveNpf(results: readonly ResultFact[]): number {
  const newestFirst = [...results].sort((a, b) => b.resolvedAt.getTime() - a.resolvedAt.getTime())
  let run = 0
  for (const r of newestFirst) {
    if (!isNpf(r)) break
    run++
  }
  return run
}

/** Why the mandate must stop collecting now, or null to carry on. */
export function suspensionReason(results: readonly ResultFact[]): string | null {
  if (results.length === 0) return null
  const latest = [...results].sort((a, b) => b.resolvedAt.getTime() - a.resolvedAt.getTime())[0]
  if (latest.outcome === "DISPUTED") return "The debtor disputed a collection"
  if (latest.outcome === "UNPAID" && latest.reasonCode && HARD_STOP_REASONS.includes(latest.reasonCode)) {
    return `Unpaid: ${latest.reasonCode}`
  }
  if (consecutiveNpf(results) >= CONSECUTIVE_NPF_LIMIT) {
    return `${CONSECUTIVE_NPF_LIMIT} consecutive unpaid (insufficient funds) collections`
  }
  return null
}

/** Statuses after which an instalment is not presented again under this mandate. */
const FINAL_OR_IN_FLIGHT: readonly CollectionInstructionStatus[] = [
  "PENDING", "SUBMITTING", "SUBMITTED", "PAID", "DISPUTED", "REJECTED",
]

/** The presentment number to use next for one instalment under one mandate, or null for none. */
export function nextPresentmentNo(facts: readonly PresentmentFact[]): number | null {
  const live = facts.filter((f) => f.status !== "CANCELLED")
  if (live.some((f) => FINAL_OR_IN_FLIGHT.includes(f.status))) return null
  if (live.length >= MAX_PRESENTMENTS_PER_CYCLE) return null
  const last = [...live].sort((a, b) => b.presentmentNo - a.presentmentNo)[0]
  if (last?.reasonCode && HARD_STOP_REASONS.includes(last.reasonCode)) return null
  return (last?.presentmentNo ?? 0) + 1
}

/** The terms a mandate may be registered with, or why not. */
export function validateMandateTerms(t: {
  amountCents: number
  maxAmountCents: number
  debitDay: number
  trackingDays: number
}): string | null {
  if (!Number.isSafeInteger(t.amountCents) || t.amountCents <= 0) return "The instalment amount must be a positive whole number of cents"
  if (!Number.isSafeInteger(t.maxAmountCents) || t.maxAmountCents < t.amountCents) {
    return "The maximum collection amount must be at least the instalment amount"
  }
  if (t.maxAmountCents > Math.floor(t.amountCents * MAX_COLLECTION_AMOUNT_MULTIPLE)) {
    return `The maximum collection amount may not exceed ${MAX_COLLECTION_AMOUNT_MULTIPLE} times the instalment`
  }
  if (!Number.isInteger(t.debitDay) || t.debitDay < 1 || t.debitDay > 31) return "The debit day must be 1–31"
  if (!Number.isInteger(t.trackingDays) || t.trackingDays < MIN_TRACKING_DAYS || t.trackingDays > MAX_TRACKING_DAYS) {
    return `Tracking days must be ${MIN_TRACKING_DAYS}–${MAX_TRACKING_DAYS}`
  }
  return null
}
