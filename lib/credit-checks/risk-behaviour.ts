/**
 * RISK_BEHAVIOUR: conduct on the account that bears on whether more credit is
 * affordable — debits the bank returned, betting, and short-term lenders.
 */
import { formatCents } from "@/lib/statement-analysis/money"
import {
  GAMBLING_INCOME_SHARE,
  GAMBLING_MERCHANTS,
  PAYDAY_LENDERS,
  RETURNED_DEBIT_MARKERS,
  mentions,
} from "./policy"
import { statementKey, type ApplicationFacts, type FlagCandidate, type StatementFacts } from "./types"

function indexesWhere(s: StatementFacts, test: (description: string, amountCents: number, nonPosting: boolean) => boolean): number[] {
  const out: number[] = []
  s.read!.transactions.forEach((t, i) => {
    if (test(t.description, t.amountCents, t.nonPosting === true)) out.push(i)
  })
  return out
}

function statementRisks(s: StatementFacts, monthlyIncomeCents: number | null): FlagCandidate[] {
  const out: FlagCandidate[] = []
  const key = statementKey(s)
  const rows = s.read!.transactions

  const returned = indexesWhere(s, (d) => RETURNED_DEBIT_MARKERS.test(d))
  if (returned.length > 0) {
    out.push({
      check: "RISK_BEHAVIOUR",
      code: "RETURNED_DEBIT",
      key,
      summary: `${returned.length} debit${returned.length === 1 ? " was" : "s were"} returned unpaid or could not be collected.`,
      evidence: { documentId: s.documentId, transactionIndexes: returned.slice(0, 20), occurrences: returned.length },
    })
  }

  const bets = indexesWhere(s, (d, amount, nonPosting) => amount < 0 && !nonPosting && GAMBLING_MERCHANTS.some((m) => mentions(d, m)))
  if (bets.length > 0) {
    const { periodStart, periodEnd } = s.read!
    // Months by length, not calendar months touched: a 15 Jul–14 Aug statement is one month, not two.
    const months = periodStart && periodEnd ? Math.max(1, (Date.parse(periodEnd) - Date.parse(periodStart) + 86_400_000) / (30.44 * 86_400_000)) : 1
    const monthlyCents = Math.round(bets.reduce((sum, i) => sum - rows[i].amountCents, 0) / months)
    if (monthlyIncomeCents === null || monthlyCents >= Math.round(monthlyIncomeCents * GAMBLING_INCOME_SHARE)) {
      out.push({
        check: "RISK_BEHAVIOUR",
        code: "GAMBLING",
        key,
        summary: monthlyIncomeCents === null
          ? `Betting spend of about ${formatCents(monthlyCents)} a month; the client's income is not known to compare it with.`
          : `Betting spend of about ${formatCents(monthlyCents)} a month, ${Math.round((monthlyCents / monthlyIncomeCents) * 100)}% of monthly income.`,
        evidence: { documentId: s.documentId, transactionIndexes: bets.slice(0, 20), monthlyCents, monthlyIncomeCents },
      })
    }
  }

  for (const lender of PAYDAY_LENDERS) {
    const hits = indexesWhere(s, (d) => mentions(d, lender))
    if (hits.length === 0) continue
    out.push({
      check: "RISK_BEHAVIOUR",
      code: "PAYDAY_LENDER",
      key: `${key}|${lender}`,
      summary: `${hits.length} transaction${hits.length === 1 ? "" : "s"} with the short-term lender ${lender}.`,
      evidence: { documentId: s.documentId, lender, transactionIndexes: hits.slice(0, 20) },
    })
  }
  return out
}

export function riskBehaviour(f: ApplicationFacts): FlagCandidate[] {
  return f.statements.filter((s) => s.state === "READ" && s.read).flatMap((s) => statementRisks(s, f.monthlyIncomeCents))
}
