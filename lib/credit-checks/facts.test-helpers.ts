/** Synthetic facts for the check unit tests. Every value is invented. */
import type { StatementTransaction } from "@/lib/statement-analysis/types"
import type { ApplicationFacts, StatementFacts } from "./types"

export function tx(date: string, description: string, amountCents: number, balanceCents: number | null = null): StatementTransaction {
  return { date, description, amountCents, balanceCents, page: 1 }
}

/** A TEXT-read Capitec statement whose balances are derived from its rows. */
export function statement(transactions: StatementTransaction[], over: Partial<StatementFacts> = {}): StatementFacts {
  const opening = 100_000
  let running = opening
  const rows = transactions.map((t) => ({ ...t, balanceCents: t.balanceCents ?? (running += t.amountCents) }))
  return {
    documentId: "doc-1",
    analysisId: "an-1",
    contentSha256: "sha-1",
    state: "READ",
    method: "TEXT",
    bank: "CAPITEC",
    balanceCheck: "PASS",
    read: {
      accountHolderName: "T TESTER",
      accountNumberLast4: "0001",
      periodStart: "2026-07-01",
      periodEnd: "2026-09-30",
      openingBalanceCents: opening,
      closingBalanceCents: rows.length ? rows[rows.length - 1].balanceCents : opening,
      transactions: rows,
    },
    authenticity: { producer: "OpenPDF 2.0.2", creator: null, createdAt: "2026-10-01T08:00:00Z", modifiedAt: null, incrementalUpdates: 0, signals: [] },
    ...over,
  }
}

export function facts(over: Partial<ApplicationFacts> = {}): ApplicationFacts {
  return {
    applicationId: "app-1",
    applicationDate: "2026-10-05",
    clientName: "Thabo Tester",
    monthlyIncomeCents: 1_845_000,
    statements: [statement([])],
    deletedStatementIds: [],
    mismatchedPayslipIds: [],
    deletedPayslipIds: [],
    priorOpenFlagApplicationIds: [],
    payslip: null,
    debts: [],
    ...over,
  }
}

export const codes = (candidates: Array<{ code: string }>) => candidates.map((c) => c.code).sort()
