/**
 * Helpers shared by the consumer-loan sources (lib/accounting/sources.ts) and
 * the asset-finance sources (lib/accounting/sources-asset-finance.ts).
 */
import type { AccountRole } from "./accounts"
import { addTo, before, type DesiredSource, type SourceLoan, type Vector } from "./source-types"

/** The role a borrower's debt is booked to: LOAN_BOOK unless the contract says otherwise. */
export const receivableOf = (loan: SourceLoan): AccountRole => loan.receivableRole ?? "LOAN_BOOK"

export function writtenOffAt(loan: SourceLoan, asOf: Date): Date | null {
  return loan.status === "WRITTEN_OFF" && before(loan.writeOffAt, asOf) ? loan.writeOffAt : null
}

/** The day a schedule item or charge is raised, or null when it never is (after a write-off or cancellation). */
export function raisedOn(loan: SourceLoan, due: Date, asOf: Date): Date | null {
  const writeOff = writtenOffAt(loan, asOf)
  if (writeOff && writeOff.getTime() <= due.getTime()) return null
  if (loan.status === "CANCELLED" && loan.closedAt && loan.closedAt.getTime() <= due.getTime()) return null
  // An early settlement re-states the remaining instalments' interest to what
  // accrued; that income is earned on the day the loan closed, not later.
  const on = loan.status === "COMPLETED" && loan.closedAt && loan.closedAt.getTime() < due.getTime() ? loan.closedAt : due
  return before(on, asOf) ? on : null
}

const CHARGE_INCOME: Record<string, AccountRole> = {
  DEFAULT_INTEREST: "DEFAULT_INTEREST_INCOME",
  SERVICE_FEE: "DEFAULT_FEE_INCOME",
  DEFAULT_ADMIN: "DEFAULT_FEE_INCOME",
  COLLECTION_FEE: "DEFAULT_FEE_INCOME",
  // A recovery cost charged to the account is recharged to the borrower, not earned.
  // UNTESTED: tax — whether the VAT inside a recharged cost is output tax on a supply to the borrower.
  RECOVERY_COST: "RECOVERY_COSTS_RECHARGED",
}

export function adjustment(loan: SourceLoan, what: string, reversedAt: Date | null): DesiredSource["change"] {
  return reversedAt
    ? { type: "DISBURSEMENT_REVERSED", date: reversedAt, description: `Disbursement of ${loan.reference} reversed: the money never reached the borrower` }
    : { type: "ADJUSTMENT", date: null, description: `${what} re-stated on ${loan.reference}` }
}

/** One source per default charge (and, on asset finance, per recovery cost charged to the account). */
export function chargeSources(loan: SourceLoan, asOf: Date, live: boolean, reversedAt: Date | null): DesiredSource[] {
  return loan.charges.map((charge) => {
    const on = live ? raisedOn(loan, charge.day, asOf) : null
    const vector: Vector = {}
    if (on) {
      addTo(vector, receivableOf(loan), charge.amount)
      addTo(vector, CHARGE_INCOME[charge.type] ?? "DEFAULT_FEE_INCOME", -charge.amount)
    }
    return {
      baseKey: `loan:${loan.id}:charge:${charge.type}:${charge.day.toISOString()}:${charge.sourceId ?? ""}`,
      loanId: loan.id, reference: loan.reference, vector,
      origin: { type: "DEFAULT_CHARGE", date: charge.day, description: `${charge.type.replaceAll("_", " ").toLowerCase()} charged on ${loan.reference}` },
      change: adjustment(loan, "Default charge", reversedAt),
    }
  })
}
