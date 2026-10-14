import { borrowerDisplayName } from "@/lib/borrower"

export type BorrowerLoan = {
  id: string
  reference: string
  client: { firstName: string; lastName: string } | null
  entity?: { legalName: string } | null
  product: { name: string } | null
}

export type Borrower = {
  loanId: string
  clientName: string
  loanReference: string
  productName: string | null
}

function loanIdOf(event: { metadata: unknown }): string | null {
  const m = event.metadata
  if (!m || typeof m !== "object" || Array.isArray(m)) return null
  const id = (m as Record<string, unknown>).loanId
  return typeof id === "string" && id.trim() !== "" ? id : null
}

export function loanIdsFromEvents(events: { metadata: unknown }[]): string[] {
  return [...new Set(events.map(loanIdOf).filter((id): id is string => id !== null))]
}

export function resolveBorrower(
  event: { metadata: unknown },
  loansById: Map<string, BorrowerLoan>,
): Borrower | null {
  const loanId = loanIdOf(event)
  if (!loanId) return null
  const loan = loansById.get(loanId)
  // Degrade to null rather than throwing: one unresolvable loan must not take
  // the whole approval queue down.
  if (!loan) return null
  return {
    loanId,
    clientName: borrowerDisplayName(loan),
    loanReference: loan.reference,
    productName: loan.product?.name ?? null,
  }
}
