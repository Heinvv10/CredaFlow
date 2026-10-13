import { createHash } from "node:crypto"
import { documentAuthenticity } from "./document-authenticity"
import { manualReview } from "./manual-review"
import { riskBehaviour } from "./risk-behaviour"
import { salaryMatch } from "./salary-match"
import type { ApplicationFacts, FlagCandidate } from "./types"
import { undisclosedDebt } from "./undisclosed-debt"

/** Stable across recomputes: the same finding on the same evidence is the same flag. */
export function fingerprint(c: Pick<FlagCandidate, "check" | "code" | "key">): string {
  return createHash("sha256").update(`${c.check}|${c.code}|${c.key}`).digest("hex").slice(0, 40)
}

/** Every check over one application's facts, one candidate per fingerprint. */
export function runChecks(facts: ApplicationFacts): Array<FlagCandidate & { fingerprint: string }> {
  const all = [
    ...documentAuthenticity(facts),
    ...salaryMatch(facts),
    ...undisclosedDebt(facts),
    ...riskBehaviour(facts),
    ...manualReview(facts),
  ]
  // Evidence names the exact read its row indexes point into, so the panel
  // quotes the rows the flag was raised on even after a re-read.
  const analysisOf = new Map(facts.statements.map((s) => [s.documentId, s.analysisId]))
  const byPrint = new Map<string, FlagCandidate & { fingerprint: string }>()
  for (const c of all) {
    const print = fingerprint(c)
    const analysisId = typeof c.evidence.documentId === "string" ? analysisOf.get(c.evidence.documentId) : undefined
    const evidence = analysisId ? { ...c.evidence, analysisId } : c.evidence
    if (!byPrint.has(print)) byPrint.set(print, { ...c, evidence, fingerprint: print })
  }
  return [...byPrint.values()]
}
