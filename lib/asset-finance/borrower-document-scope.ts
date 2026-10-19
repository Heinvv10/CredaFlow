import type { Prisma } from "@prisma/client"

/**
 * The EntityDocument filter that scopes a query to one borrower: the entity
 * when there is one, otherwise the individual. A null id in a Prisma filter
 * means IS NULL, so `entityId: loan.entityId` for an individual lessee
 * matched every individual's documents; this never filters on a null id.
 */
export function borrowerDocumentWhere(borrower: { entityId: string | null; clientId: string | null }): Prisma.EntityDocumentWhereInput {
  if (borrower.entityId) return { entityId: borrower.entityId }
  if (borrower.clientId) return { clientId: borrower.clientId, entityId: null }
  throw new Error("A borrower document filter needs an entity or a client")
}

/**
 * Live staff-uploaded LEGAL_DOCUMENT rows that may evidence a loan's
 * commercial cancellation: its own borrower's, filed on no deal or on this
 * loan's deal. Shared by the staff panel's list and the server's check.
 */
export function cancellationEvidenceWhere(
  tenantId: string,
  loan: { entityId: string | null; clientId: string | null; assetFinanceDeal: { id: string } | null },
): Prisma.EntityDocumentWhereInput {
  return {
    tenantId, ...borrowerDocumentWhere(loan), docType: "LEGAL_DOCUMENT", uploadedByType: "staff", deletedAt: null,
    OR: [{ dealId: null }, { dealId: loan.assetFinanceDeal?.id ?? null }],
  }
}
