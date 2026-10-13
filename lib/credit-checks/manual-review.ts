/**
 * MANUAL_REVIEW: the checks could not run on solid ground, so a person reads
 * the statement instead. Never a finding about the client.
 */
import { EXPECTED_PRODUCERS } from "./policy"
import { statementKey, type ApplicationFacts, type FlagCandidate, type StatementFacts } from "./types"

const PENDING_SUMMARY = {
  vlm: "The statement has not been read yet (it needs the vision reader). Read it by hand or retry later.",
  consent: "The client uploaded this statement without POPIA consent to process it, so it was not read. Review it by hand or obtain consent.",
  file_missing: "The statement's file could not be found in storage, so it was not read. Review the original by hand.",
  reader_unavailable: "The statement could not be read because the PDF tools are unavailable on the server. Read it by hand or retry later.",
} as const

/** Signals that mean the file-level authenticity checks had nothing to work with. */
const UNCHECKABLE = ["NOT_A_PDF", "TEXT_LAYER_ABSENT", "METADATA_AMBIGUOUS"]

function review(s: StatementFacts): FlagCandidate | null {
  const base = { check: "MANUAL_REVIEW" as const, key: statementKey(s) }
  const evidence = { documentId: s.documentId }
  if (s.state === "PENDING") {
    const reason = s.pendingReason ?? "vlm"
    return { ...base, code: reason === "consent" ? "NOT_READ_NO_CONSENT" : "NOT_READ", summary: PENDING_SUMMARY[reason], evidence: { ...evidence, reason } }
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
  // A read missing who or when cannot be name-matched, dated or salary-matched.
  if (s.state === "READ" && (!s.read?.accountHolderName || !s.read.periodStart || !s.read.periodEnd)) {
    return {
      ...base,
      code: "READ_INCOMPLETE",
      summary: "The statement was read but its account holder or period could not be, so it was not name-matched, dated or salary-matched. Check them by hand.",
      evidence: { ...evidence, holderRead: !!s.read?.accountHolderName, periodRead: !!(s.read?.periodStart && s.read.periodEnd) },
    }
  }
  // A reconciling read of a photo, a scan or an unprofiled bank's PDF has had
  // no file-level authenticity check at all: an edited image balances too.
  const signals = s.authenticity?.signals ?? []
  if (signals.some((x) => UNCHECKABLE.includes(x)) || !s.bank || !EXPECTED_PRODUCERS[s.bank]) {
    return {
      ...base,
      code: "AUTHENTICITY_UNCHECKED",
      summary: "This statement is a photo, a scan or from a bank without a known PDF profile, so its authenticity could not be checked automatically. Compare it with the bank's original.",
      evidence: { ...evidence, signals, bank: s.bank },
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
    }, ...f.deletedStatementIds.map((documentId): FlagCandidate => ({
      check: "MANUAL_REVIEW",
      code: "STATEMENT_DELETED",
      key: documentId,
      summary: "A bank statement read for this client was later deleted. Review what it showed before deciding.",
      evidence: { documentId },
    }))]
  }
  const out = f.statements.map(review).filter((c): c is FlagCandidate => c !== null)
  for (const documentId of f.deletedStatementIds) {
    out.push({
      check: "MANUAL_REVIEW",
      code: "STATEMENT_DELETED",
      key: documentId,
      summary: "A bank statement read for this client was later deleted. Review what it showed before deciding.",
      evidence: { documentId },
    })
  }
  if (!f.payslip) {
    out.push({
      check: "MANUAL_REVIEW",
      code: "NO_PAYSLIP",
      key: f.applicationId,
      summary: "No recent payslip is on file, so the salary on the statement could not be matched to one. Verify the income another way.",
      evidence: {},
    })
  }
  return out
}
