/**
 * MANUAL_REVIEW: the checks could not run on solid ground, so a person reads
 * the statement instead. Never a finding about the client.
 */
import type { ApplicationFacts, FlagCandidate, StatementFacts } from "./types"

function review(s: StatementFacts): FlagCandidate | null {
  const base = { check: "MANUAL_REVIEW" as const, key: s.analysisId ?? s.documentId }
  const evidence = { documentId: s.documentId }
  if (s.state === "PENDING") {
    return { ...base, code: "NOT_READ", summary: "The statement has not been read yet (it needs the vision reader). Read it by hand or retry later.", evidence }
  }
  if (s.state === "UNREADABLE" || s.state === "UNSUPPORTED") {
    return {
      ...base,
      code: "UNREADABLE",
      summary: s.state === "UNSUPPORTED"
        ? "The statement is too long for the automatic reader. Review it by hand."
        : "No reader could read the statement. Review it by hand.",
      evidence: { ...evidence, state: s.state },
    }
  }
  if (s.balanceCheck !== "PASS" && (s.method === "VLM" || s.balanceCheck === "NOT_APPLICABLE")) {
    return {
      ...base,
      code: "UNVERIFIED_READ",
      summary: s.method === "VLM"
        ? "The automatic read of this statement does not reconcile, so it may be a misread. The checks on it are unreliable; review the statement by hand."
        : "The statement's opening or closing balance could not be read, so the read cannot be verified. Review it by hand.",
      evidence: { ...evidence, method: s.method, balanceCheck: s.balanceCheck },
    }
  }
  return null
}

export function manualReview(f: ApplicationFacts): FlagCandidate[] {
  if (f.statements.length === 0) {
    return [{
      check: "MANUAL_REVIEW",
      code: "NO_STATEMENT",
      key: f.applicationId,
      summary: "No recent bank statement is on file for this application.",
      evidence: {},
    }]
  }
  return f.statements.map(review).filter((c): c is FlagCandidate => c !== null)
}
