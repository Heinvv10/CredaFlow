/**
 * An external, pseudonymised LMS extract as an outcome source (DESIGN.md
 * §4.1). Interface only: there is no connection here, and the job does not
 * run it. A real reader is a read-only role over a private schema the
 * application role cannot read; nothing from any extract enters the
 * repository. Keys are opaque (HMAC codes made at source); the adapter never
 * sees a name, ID number, contact or bank detail, and names no lender.
 *
 * The extract's decisions arrive as CreditDecisionRecord rows written by its
 * import (actor SYSTEM, ruleVersion `external:<extract version>`), so each
 * extract loan names the decision record it belongs to.
 */
import type { AdapterContext, AdapterResult, OutcomeSourceAdapter } from "./adapter"
import { deriveLoanOutcomes } from "./derive"
import type { LoanEnd, LoanFacts } from "./facts"

/** One loan of an extract. Days are SAST `yyyy-mm-dd`; amounts cents. */
export interface ExtractLoanRow {
  /** Pseudonymous loan key. */
  loanKey: string
  decisionRecordId: string
  maturityDay: string
  closure: { status: "SETTLED" | "WRITTEN_OFF" | "CANCELLED"; day: string | null } | null
  instalments: Array<{ key: string; no: number; dueDay: string; totalDueCents: number; paidInFull: boolean; paidDay: string | null }>
  /** One entry per day the source recorded the loan's position. */
  dpdHistory: Array<{ day: string; dpd: number; defaulted: boolean }>
  returns: Array<{ key: string; no: number; amountCents: number; reasonCode: string | null; resolvedAt: Date }>
}

export interface ExtractReader {
  loans(tenantId: string): Promise<ExtractLoanRow[]>
}

/** Every ref is prefixed with the loan key, so an extract's refs never meet CredaFlow ids. */
export function extractLoanFacts(row: ExtractLoanRow): LoanFacts {
  const end: LoanEnd = row.closure ? { kind: row.closure.status, day: row.closure.day } : { kind: "OPEN" }
  return {
    ref: row.loanKey,
    maturityDay: row.maturityDay,
    end,
    instalments: [...row.instalments].sort((a, b) => a.dueDay.localeCompare(b.dueDay) || a.no - b.no).map((i) => ({
      ref: `${row.loanKey}:i${i.no}:${i.key}`, installmentNo: i.no, dueDay: i.dueDay, totalDueCents: i.totalDueCents,
      paidInFull: i.paidInFull, paidDay: i.paidInFull ? i.paidDay : null,
    })),
    arrearsHistory: row.dpdHistory.map((h) => ({ day: h.day, daysInArrears: h.dpd, defaulted: h.defaulted })),
    returns: row.returns.map((r) => ({
      ref: `${row.loanKey}:r:${r.key}`, installmentNo: r.no, amountCents: r.amountCents, reasonCode: r.reasonCode, resolvedAt: r.resolvedAt,
    })),
  }
}

export function externalExtractAdapter(reader: ExtractReader): OutcomeSourceAdapter {
  return {
    sourceSystem: "external_extract",
    async derive({ tenantId, today }: AdapterContext): Promise<AdapterResult> {
      const result: AdapterResult = { outcomes: [], decisionRecordIds: [], failures: [] }
      for (const row of await reader.loans(tenantId)) {
        try {
          result.outcomes.push(...deriveLoanOutcomes(row.decisionRecordId, extractLoanFacts(row), today))
          result.decisionRecordIds.push(row.decisionRecordId)
        } catch (error) {
          result.failures.push({ ref: row.loanKey, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return result
    },
  }
}
