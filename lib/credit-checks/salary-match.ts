/**
 * SALARY_MATCH: does the statement show the payslip's net pay arriving?
 *
 * For each month whose whole pay window (pay date ± SALARY_DATE_WINDOW_DAYS)
 * a statement covers, look for a credit within tolerance of the validated net
 * pay. Only validated figures from a payslip that names the client are used:
 * matching against a misread or someone else's payslip would clear or raise
 * flags on numbers nobody verified.
 */
import { formatCents } from "@/lib/statement-analysis/money"
import {
  SALARY_AMOUNT_TOLERANCE_CENTS,
  SALARY_AMOUNT_TOLERANCE_PCT,
  SALARY_CANDIDATE_MIN_SHARE,
  SALARY_DATE_WINDOW_DAYS,
} from "./policy"
import { addDays, dayInMonth, monthsCovered } from "./dates"
import { statementKey, type ApplicationFacts, type FlagCandidate } from "./types"

interface MonthResult {
  expectedDate: string
  matched: boolean
  /** The closest salary-sized credit in the window, if any. */
  candidate: { documentId: string; index: number; amountCents: number; date: string } | null
  documentIds: Set<string>
}

const notClients = (payslipDocumentId: string): FlagCandidate => ({
  check: "SALARY_MATCH",
  code: "PAYSLIP_NOT_CLIENTS",
  key: payslipDocumentId,
  summary: "The payslip's name or ID number does not match the client, so it was not used. Verify whose payslip it is.",
  evidence: { payslipDocumentId },
})

/** Every payslip that names someone else is raised, not only the newest: a later upload must not hide one. */
export function salaryMatch(f: ApplicationFacts): FlagCandidate[] {
  const others = f.mismatchedPayslipIds.filter((id) => id !== f.payslip?.documentId).map(notClients)
  return [...others, ...againstNewestPayslip(f)]
}

function againstNewestPayslip(f: ApplicationFacts): FlagCandidate[] {
  const slip = f.payslip
  const read = f.statements.filter((s) => s.state === "READ" && s.read?.periodStart && s.read.periodEnd)
  if (!slip) return []
  if (!slip.matchesClient) return [notClients(slip.documentId)]
  if (!slip.validated || slip.netPayCents === null || !slip.payDate) {
    return [{
      check: "SALARY_MATCH",
      code: "PAYSLIP_UNVALIDATED",
      key: slip.documentId,
      summary: "The payslip's figures failed validation, so the salary cannot be matched to the statement. Verify the payslip by hand.",
      evidence: { payslipDocumentId: slip.documentId },
    }]
  }
  if (read.length === 0) return []
  const net = slip.netPayCents
  const tolerance = Math.max(SALARY_AMOUNT_TOLERANCE_CENTS, Math.round((net * SALARY_AMOUNT_TOLERANCE_PCT) / 100))
  const payDay = Number(slip.payDate.slice(8, 10))
  const months = new Map<string, MonthResult>()

  for (const s of read) {
    const { periodStart, periodEnd, transactions } = s.read!
    for (const month of monthsCovered(periodStart!, periodEnd!)) {
      const expectedDate = dayInMonth(month, payDay)
      const from = addDays(expectedDate, -SALARY_DATE_WINDOW_DAYS)
      const to = addDays(expectedDate, SALARY_DATE_WINDOW_DAYS)
      if (from < periodStart! || to > periodEnd!) continue
      const r = months.get(month) ?? { expectedDate, matched: false, candidate: null, documentIds: new Set<string>() }
      r.documentIds.add(s.documentId)
      transactions.forEach((t, index) => {
        if (t.nonPosting || t.date < from || t.date > to) return
        if (Math.abs(t.amountCents - net) <= tolerance) r.matched = true
        else if (t.amountCents >= net * SALARY_CANDIDATE_MIN_SHARE
          && (!r.candidate || Math.abs(t.amountCents - net) < Math.abs(r.candidate.amountCents - net))) {
          r.candidate = { documentId: s.documentId, index, amountCents: t.amountCents, date: t.date }
        }
      })
      months.set(month, r)
    }
  }

  const analysisKey = read.map(statementKey).sort().join(",")
  if (months.size === 0) {
    // No pay window fell wholly inside any statement (a pay date near month
    // end on calendar-month statements, or a short statement): nothing was checked.
    return [{
      check: "SALARY_MATCH",
      code: "SALARY_NOT_CHECKED",
      key: `${slip.documentId}|${analysisKey}`,
      summary: `No statement covers a whole pay window around the payslip's pay day (${slip.payDate.slice(8, 10)}), so the salary could not be matched. Check the salary credits by hand.`,
      evidence: { payslipDocumentId: slip.documentId, documentId: read[0].documentId, documentIds: read.map((x) => x.documentId) },
    }]
  }
  return [...months].filter(([, r]) => !r.matched).map(([month, r]): FlagCandidate => {
    const evidence = {
      payslipDocumentId: slip.documentId,
      // The statement to open from the panel; a candidate below names its own.
      documentId: [...r.documentIds][0],
      documentIds: [...r.documentIds],
      month,
      expectedDate: r.expectedDate,
      netPayCents: net,
      ...(r.candidate ? { documentId: r.candidate.documentId, transactionIndexes: [r.candidate.index], creditCents: r.candidate.amountCents } : {}),
    }
    return r.candidate
      ? {
          check: "SALARY_MATCH",
          code: "SALARY_AMOUNT_MISMATCH",
          key: `${slip.documentId}|${month}|${analysisKey}`,
          summary: `Around ${r.expectedDate} the statement shows a credit of ${formatCents(r.candidate.amountCents)}, not the payslip's net pay of ${formatCents(net)}.`,
          evidence,
        }
      : {
          check: "SALARY_MATCH",
          code: "NO_SALARY_CREDIT",
          key: `${slip.documentId}|${month}|${analysisKey}`,
          summary: `No salary credit near ${r.expectedDate} (payslip net pay ${formatCents(net)}).`,
          evidence,
        }
  })
}
