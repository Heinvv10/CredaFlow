/**
 * MANUAL_REVIEW: the checks could not run on solid ground, so a person reads
 * the statement instead. Never a finding about the client.
 *
 * Every concern about a statement is its own flag: one code must not shadow
 * another, or clearing the first would leave the second never raised.
 */
import { producerExpected } from "./document-authenticity"
import { EXPECTED_PRODUCERS } from "./policy"
import { statementKey, type ApplicationFacts, type FlagCandidate, type StatementFacts } from "./types"

const PENDING_SUMMARY = {
  vlm: "The statement has not been read yet (it needs the vision reader). Read it by hand or retry later.",
  consent: "The client uploaded this statement without POPIA consent to process it, so it was not read. Review it by hand or obtain consent.",
  file_missing: "The statement's file could not be found in storage, so it was not read. Review the original by hand.",
  reader_unavailable: "The statement could not be read because the PDF tools are unavailable on the server. Read it by hand or retry later.",
} as const

/** Signals that mean the file-level authenticity checks had nothing to work with. */
const UNCHECKABLE = ["NOT_A_PDF", "TEXT_LAYER_ABSENT", "METADATA_AMBIGUOUS", "TEXT_LAYOUT_UNRECOGNISED"]

function unreadableSummary(s: StatementFacts): string {
  if (s.authenticity?.signals.includes("METADATA_AMBIGUOUS")) {
    return "The PDF's metadata contradicts itself (a field appears twice), so it was not read automatically. Treat it as possibly altered and review it by hand."
  }
  return s.state === "UNSUPPORTED"
    ? "The statement is too long for the automatic reader. Review it by hand."
    : "No reader could read the statement. Review it by hand."
}

function review(s: StatementFacts): FlagCandidate[] {
  const base = { check: "MANUAL_REVIEW" as const, key: statementKey(s) }
  const evidence = { documentId: s.documentId }
  if (s.state === "PENDING") {
    const reason = s.pendingReason ?? "vlm"
    return [{ ...base, code: reason === "consent" ? "NOT_READ_NO_CONSENT" : "NOT_READ", summary: PENDING_SUMMARY[reason], evidence: { ...evidence, reason } }]
  }
  if (s.state === "UNREADABLE" || s.state === "UNSUPPORTED") {
    return [{ ...base, code: "UNREADABLE", summary: unreadableSummary(s), evidence: { ...evidence, state: s.state, signals: s.authenticity?.signals ?? [] } }]
  }
  const out: FlagCandidate[] = []
  if (s.balanceCheck !== "PASS" && (s.method === "VLM" || s.balanceCheck === "NOT_APPLICABLE")) {
    out.push({
      ...base,
      code: "UNVERIFIED_READ",
      summary: s.method === "VLM"
        ? "The automatic read of this statement does not reconcile, so it may be a misread. The checks on it are unreliable; review the statement by hand."
        : "The statement's opening or closing balance could not be read, so the read cannot be verified. Review it by hand.",
      evidence: { ...evidence, method: s.method, balanceCheck: s.balanceCheck },
    })
  }
  // A read missing who or when cannot be name-matched, dated or salary-matched.
  if (!s.read?.accountHolderName || !s.read.periodStart || !s.read.periodEnd) {
    out.push({
      ...base,
      code: "READ_INCOMPLETE",
      summary: "The statement was read but its account holder or period could not be, so it was not name-matched, dated or salary-matched. Check them by hand.",
      evidence: { ...evidence, holderRead: !!s.read?.accountHolderName, periodRead: !!(s.read?.periodStart && s.read.periodEnd) },
    })
  }
  // The bank prints no opening balance, so the first row is checked by nothing:
  // a salary edited there reconciles. A person compares it with the original.
  const rowEvidence = (t: { date: string; amountCents: number } | undefined) => (t ? { date: t.date, amountCents: t.amountCents } : null)
  if (s.authenticity?.signals.includes("OPENING_DERIVED")) {
    out.push({
      ...base,
      code: "FIRST_ROW_UNVERIFIED",
      summary: "This bank prints no opening balance, so the statement's first transaction cannot be checked by arithmetic. Compare it with the bank's original or the previous statement.",
      evidence: { ...evidence, firstRow: rowEvidence(s.read?.transactions[0]) },
    })
  }
  if (s.authenticity?.signals.includes("ROWS_WITHOUT_BALANCE")) {
    out.push({
      ...base,
      code: "ROWS_UNCHECKED",
      summary: "Some transactions on this statement print no running balance, so they are only checked together with the rows around them. Compare them with the bank's original.",
      evidence: { ...evidence, rows: (s.read?.transactions ?? []).flatMap((t, i) => (t.balanceCents === null && !t.nonPosting ? [i] : [])).slice(0, 20) },
    })
  }
  if (s.authenticity?.signals.includes("CLOSING_DERIVED")) {
    out.push({
      ...base,
      code: "LAST_ROW_UNVERIFIED",
      summary: "This bank prints no closing balance, so the statement's last transaction cannot be checked by arithmetic. Compare it with the bank's original or the next statement.",
      evidence: { ...evidence, lastRow: rowEvidence(s.read?.transactions[s.read.transactions.length - 1]) },
    })
  }
  // A photo, a scan, an unrecognised layout or an unprofiled bank's PDF has
  // had no file-level authenticity check at all: an edited image balances too.
  // Nor has a PDF that names no producer or creator: some banks (Discovery's
  // app) write none, so its producer check passes, but so does any file
  // stripped of its metadata.
  const signals = s.authenticity?.signals ?? []
  // Only where the bank's profile accepts no metadata: elsewhere PRODUCER_UNEXPECTED already says it.
  const noMetadata = !!s.authenticity && !s.authenticity.producer && !s.authenticity.creator
    && !!s.bank && !!EXPECTED_PRODUCERS[s.bank] && producerExpected(s.bank, null, null)
  if (signals.some((x) => UNCHECKABLE.includes(x)) || !s.bank || !EXPECTED_PRODUCERS[s.bank] || noMetadata) {
    out.push({
      ...base,
      code: "AUTHENTICITY_UNCHECKED",
      summary: signals.includes("METADATA_AMBIGUOUS")
        ? "The PDF's metadata contradicts itself (a field appears twice), so its authenticity could not be checked. Treat it as possibly altered and compare it with the bank's original."
        : "This statement is a photo, a scan, an unrecognised layout, a PDF without producer metadata or from a bank without a known PDF profile, so its authenticity could not be checked automatically. Compare it with the bank's original.",
      evidence: { ...evidence, signals, bank: s.bank, ...(noMetadata ? { noMetadata } : {}) },
    })
  }
  return out
}

function each(ids: string[], code: string, summary: string, field = "documentId"): FlagCandidate[] {
  return ids.map((id) => ({ check: "MANUAL_REVIEW" as const, code, key: id, summary, evidence: { [field]: id } }))
}

export function manualReview(f: ApplicationFacts): FlagCandidate[] {
  const out: FlagCandidate[] = f.statements.length === 0
    ? [{ check: "MANUAL_REVIEW", code: "NO_STATEMENT", key: f.applicationId, summary: "No recent bank statement is on file for this application.", evidence: {} }]
    : f.statements.flatMap(review)
  if (f.statements.length > 0 && !f.payslip && f.unreadPayslipIds.length === 0) {
    out.push({
      check: "MANUAL_REVIEW",
      code: "NO_PAYSLIP",
      key: f.applicationId,
      summary: "No recent payslip is on file, so the salary on the statement could not be matched to one. Verify the income another way.",
      evidence: {},
    })
  }
  out.push(...each(f.unreadPayslipIds, "PAYSLIP_NOT_READ", "A payslip is on file but its figures were not extracted (extraction failed, was skipped for lack of consent, or is still running). Read it by hand.", "payslipDocumentId"))
  out.push(...each(f.deletedStatementIds, "STATEMENT_DELETED", "A bank statement read for this client was later deleted. Review what it showed before deciding."))
  out.push(...each(f.deletedPayslipIds, "PAYSLIP_DELETED", "A payslip uploaded for this client was later deleted. Review what it showed before deciding.", "payslipDocumentId"))
  for (const prior of f.priorOpenFlagApplications) {
    out.push({
      check: "MANUAL_REVIEW",
      code: "PRIOR_OPEN_FLAGS",
      key: prior.id,
      summary: `The client's application ${prior.reference} (${prior.status.toLowerCase().replace(/_/g, " ")}) still has credit checks open. Review them before deciding on this one.`,
      evidence: { applicationId: prior.id, reference: prior.reference, status: prior.status },
    })
  }
  return out
}
