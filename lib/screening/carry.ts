/**
 * When a re-screen may reuse an earlier human decision, pure. The database
 * repeats the structural part (guardScreeningCheckRecord); the age and
 * reviewer rules live only here.
 *
 *   - Only at the SAME result level: POSSIBLE → POSSIBLE, or CONFIRMED →
 *     CONFIRMED (policy 2026-10-14: an accepted confirmed PEP is not
 *     re-referred every cycle). Never upward: a decision on a POSSIBLE_MATCH
 *     never carries onto a CONFIRMED_MATCH of the same entry.
 *   - Never for SANCTIONS, at any level.
 *   - Only FALSE_POSITIVE or ACCEPTED. REJECTED is never carried: it raised a
 *     sticky ScreeningBlock, which is what keeps the subject blocked.
 *   - Only for the SAME screened identity (subjectFingerprint): a clearance
 *     made for one name / ID never carries onto a client whose details changed.
 *   - Only for the same type, result and list entries (ids, versions, matched
 *     names and scores), and only when every match has a list-entry id. A match without ids, or
 *     with none at all, is referred every time.
 *   - Only within CARRY_MAX_AGE_DAYS of the original human decision, and only
 *     if that reviewer still holds the lender's current minimum review role.
 */
import { createHash } from "node:crypto"
import type { ScreeningDecision, ScreeningResult, ScreeningType } from "@prisma/client"
import { CARRY_MAX_AGE_DAYS } from "./policy"
import type { ScreeningMatch } from "./types"

/**
 * Stable across runs: type, result and the sorted, de-duplicated entries —
 * id, list version, matched name and score. JSON-encoded, so no character in
 * any field can make two different match sets hash alike.
 */
export function matchFingerprint(type: ScreeningType, result: ScreeningResult, matches: ScreeningMatch[]): string {
  const entries = [...new Set(matches.map((m) => JSON.stringify([m.listEntryId, m.listVersion ?? null, m.matchedName ?? null, m.score ?? null])))].sort()
  return createHash("sha256").update(JSON.stringify([type, result, entries])).digest("hex")
}

export function carryableMatches(matches: ScreeningMatch[]): boolean {
  return matches.length > 0 && matches.every((m) => typeof m.listEntryId === "string" && m.listEntryId.trim() !== "")
}

export type PriorDecision = {
  id: string
  type: ScreeningType
  result: ScreeningResult
  matchFingerprint: string | null
  subjectFingerprint: string | null
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
  candidate: { type: ScreeningType; result: ScreeningResult; fingerprint: string; matches: ScreeningMatch[]; subjectFingerprint: string },
  priors: PriorDecision[],
  opts: { now: Date; reviewerEligible: (userId: string) => boolean },
): { prior: PriorDecision; root: PriorDecision } | null {
  if (candidate.type === "SANCTIONS") return null
  if (candidate.result !== "POSSIBLE_MATCH" && candidate.result !== "CONFIRMED_MATCH") return null
  if (!carryableMatches(candidate.matches)) return null
  const byId = new Map(priors.map((p) => [p.id, p]))
  const maxAgeMs = CARRY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  const same = priors
    .filter((p) =>
      p.decision !== null && CARRYABLE.includes(p.decision) && p.result === candidate.result
      && p.type === candidate.type && p.matchFingerprint === candidate.fingerprint
      && p.subjectFingerprint === candidate.subjectFingerprint)
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
