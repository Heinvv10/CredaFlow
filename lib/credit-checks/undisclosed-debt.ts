/**
 * UNDISCLOSED_DEBT: a debit order to a credit provider that matches neither a
 * declared debt nor a bureau account. Undisclosed instalments understate the
 * client's obligations, which is what the NCA affordability assessment rests on.
 */
import { formatCents } from "@/lib/statement-analysis/money"
import {
  CREDIT_PROVIDERS,
  CREDIT_WORD_MARKERS,
  DEBIT_ORDER_MARKERS,
  INSTALMENT_MATCH_PCT,
  mentions,
} from "./policy"
import type { ApplicationFacts, DebtFacts, FlagCandidate } from "./types"

/** Words too generic to tie a debit order to a named debt. */
const GENERIC = new Set(["FINANCE", "FINANCIAL", "LOAN", "LOANS", "CREDIT", "BANK", "PERSONAL", "SERVICES", "PTY", "LTD", "LIMITED", "DEBIT", "ORDER", "PAYMENT"])

/** A stable name for the other side of a debit: marker, references and digits removed. */
export function counterpartyKey(description: string): string {
  const upper = description.toUpperCase()
  const afterColon = upper.includes(":") ? upper.slice(upper.lastIndexOf(":") + 1) : upper
  return afterColon
    .replace(new RegExp(DEBIT_ORDER_MARKERS.source, "gi"), " ")
    .split(/[^A-Z0-9&]+/)
    .filter((w) => w && !/\d/.test(w))
    .slice(0, 3)
    .join(" ")
}

function distinctive(name: string): string[] {
  return name.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 4 && !GENERIC.has(w))
}

function namesOverlap(a: string, b: string): boolean {
  const theirs = new Set(distinctive(b))
  return distinctive(a).some((w) => theirs.has(w))
}

function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

function creditLike(description: string): boolean {
  return CREDIT_WORD_MARKERS.test(description) || CREDIT_PROVIDERS.some((p) => mentions(description, p))
}

function matchesDebt(counterparty: string, monthlyCents: number, debts: DebtFacts[]): boolean {
  return debts.some((d) =>
    namesOverlap(counterparty, d.name)
    && Math.abs(monthlyCents - d.monthlyInstalmentCents) <= (d.monthlyInstalmentCents * INSTALMENT_MATCH_PCT) / 100)
}

interface Group {
  documentId: string
  analysisId: string | null
  indexes: number[]
  amounts: number[]
  months: Set<string>
  marked: boolean
  creditLike: boolean
}

export function undisclosedDebt(f: ApplicationFacts): FlagCandidate[] {
  const out: FlagCandidate[] = []
  for (const s of f.statements) {
    if (s.state !== "READ" || !s.read) continue
    const groups = new Map<string, Group>()
    s.read.transactions.forEach((t, i) => {
      if (t.nonPosting || t.amountCents >= 0) return
      const key = counterpartyKey(t.description)
      if (!key) return
      const g = groups.get(key) ?? { documentId: s.documentId, analysisId: s.analysisId, indexes: [], amounts: [], months: new Set<string>(), marked: false, creditLike: false }
      g.indexes.push(i)
      g.amounts.push(-t.amountCents)
      g.months.add(t.date.slice(0, 7))
      g.marked ||= DEBIT_ORDER_MARKERS.test(t.description)
      g.creditLike ||= creditLike(t.description)
      groups.set(key, g)
    })
    for (const [counterparty, g] of groups) {
      if (!g.creditLike || !(g.marked || g.months.size >= 2)) continue
      const monthlyCents = median(g.amounts)
      if (matchesDebt(counterparty, monthlyCents, f.debts)) continue
      out.push({
        check: "UNDISCLOSED_DEBT",
        code: "UNDISCLOSED_DEBIT_ORDER",
        key: `${g.analysisId ?? g.documentId}|${counterparty}`,
        summary: `Recurring debit of about ${formatCents(monthlyCents)} to "${counterparty}" matches no declared debt or bureau account.`,
        evidence: {
          documentId: g.documentId,
          counterparty,
          transactionIndexes: g.indexes.slice(0, 20),
          monthlyCents,
          occurrences: g.indexes.length,
        },
      })
    }
  }
  return out
}
