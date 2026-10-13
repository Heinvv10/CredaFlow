/**
 * SALARY_MATCH: does the statement show the payslip's net pay arriving?
 *
 * For each month whose whole pay window (pay date ± SALARY_DATE_WINDOW_DAYS)
 * a statement covers, look for a credit within tolerance of the validated net
 * pay. Only payslip figures that passed validation are used: matching against
 * a misread payslip would clear or raise flags on numbers nobody verified.
 */
import { formatCents } from "@/lib/statement-analysis/money"
import {
  SALARY_AMOUNT_TOLERANCE_CENTS,
  SALARY_AMOUNT_TOLERANCE_PCT,
  SALARY_CANDIDATE_MIN_SHARE,
  SALARY_DATE_WINDOW_DAYS,
} from "./policy"
import { addDays, dayInMonth, monthsCovered } from "./dates"
import type { ApplicationFacts, FlagCandidate } from "./types"

interface MonthResult {
  expectedDate: string
  matched: boolean
  /** The closest salary-sized credit in the window, if any. */
  candidate: { documentId: string; index: number; amountCents: number; date: string } | null
  documentIds: Set<string>
}

export function salaryMatch(f: ApplicationFacts): FlagCandidate[] {
  const slip = f.payslip
  const read = f.statements.filter((s) => s.state === "READ" && s.read?.periodStart && s.read.periodEnd)
  if (!slip || read.length === 0) return []
  if (!slip.validated || slip.netPayCents === null || !slip.payDate) {
    return [{
      check: "SALARY_MATCH",
      code: "PAYSLIP_UNVALIDATED",
      key: slip.documentId,
      summary: "The payslip's figures failed validation, so the salary cannot be matched to the statement. Verify the payslip by hand.",
      evidence: { payslipDocumentId: slip.documentId },
    }]
  }
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

  const analysisKey = read.map((s) => s.analysisId ?? s.documentId).sort().join(",")
  return [...months].filter(([, r]) => !r.matched).map(([month, r]): FlagCandidate => {
    const evidence = {
      payslipDocumentId: slip.documentId,
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
