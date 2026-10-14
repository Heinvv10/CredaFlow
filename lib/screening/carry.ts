/**
 * When a re-screen may reuse an earlier human decision, pure. The database
 * repeats the structural part (guardScreeningCheckRecord); the age and
 * reviewer rules live only here.
 *
 *   - Only onto a POSSIBLE_MATCH, from a POSSIBLE_MATCH: a CONFIRMED_MATCH is
 *     always referred again, whatever was decided before.
 *   - Only FALSE_POSITIVE or ACCEPTED. REJECTED is never carried: it raised a
 *     sticky ScreeningBlock, which is what keeps the subject blocked.
 *   - Only for the same type, result and list entries (ids and versions),
 *     and only when every match has a list-entry id. A match without ids, or
 *     with none at all, is referred every time.
 *   - Only within CARRY_MAX_AGE_DAYS of the original human decision, and only
 *     if that reviewer still holds the lender's current minimum review role.
 */
import { createHash } from "node:crypto"
import type { ScreeningDecision, ScreeningResult, ScreeningType } from "@prisma/client"
import { CARRY_MAX_AGE_DAYS } from "./policy"
import type { ScreeningMatch } from "./types"

/** Stable across runs: type, result and the sorted, de-duplicated entry ids with their versions. */
export function matchFingerprint(type: ScreeningType, result: ScreeningResult, matches: ScreeningMatch[]): string {
  const entries = [...new Set(matches.map((m) => `${m.listEntryId}@${m.listVersion ?? ""}`))].sort()
  return createHash("sha256").update(`${type}|${result}|${entries.join("\u0000")}`).digest("hex")
}

export function carryableMatches(matches: ScreeningMatch[]): boolean {
  return matches.length > 0 && matches.every((m) => typeof m.listEntryId === "string" && m.listEntryId.trim() !== "")
}

export type PriorDecision = {
  id: string
  type: ScreeningType
  result: ScreeningResult
  matchFingerprint: string | null
  decision: ScreeningDecision | null
  decisionReason: string | null
  reviewedById: string | null
  reviewedAt: Date | null
  carriedFromCheckId: string | null
  createdAt: Date
}

/** The human decision a (possibly carried) decision descends from; null if the chain is broken. */
export function decisionRoot(prior: PriorDecision, byId: Map<string, PriorDecision>): PriorDecision | null {
  let node: PriorDecision | undefined = prior
  for (let hops = 0; node && hops < 100; hops++) {
    if (node.reviewedById) return node
    node = node.carriedFromCheckId ? byId.get(node.carriedFromCheckId) : undefined
  }
  return null
}

const CARRYABLE: readonly ScreeningDecision[] = ["FALSE_POSITIVE", "ACCEPTED"]

export function carriedDecision(
  candidate: { type: ScreeningType; result: ScreeningResult; fingerprint: string; matches: ScreeningMatch[] },
  priors: PriorDecision[],
  opts: { now: Date; reviewerEligible: (userId: string) => boolean },
): { prior: PriorDecision; root: PriorDecision } | null {
  if (candidate.result !== "POSSIBLE_MATCH" || !carryableMatches(candidate.matches)) return null
  const byId = new Map(priors.map((p) => [p.id, p]))
  const maxAgeMs = CARRY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  const same = priors
    .filter((p) =>
      p.decision !== null && CARRYABLE.includes(p.decision) && p.result === "POSSIBLE_MATCH"
      && p.type === candidate.type && p.matchFingerprint === candidate.fingerprint)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  for (const prior of same) {
    const root = decisionRoot(prior, byId)
    if (!root?.reviewedById || !root.reviewedAt) continue
    if (opts.now.getTime() - root.reviewedAt.getTime() > maxAgeMs) continue
    if (!opts.reviewerEligible(root.reviewedById)) continue
    return { prior, root }
  }
  return null
}
