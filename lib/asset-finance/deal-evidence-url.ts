/**
 * Staff URL of a deal's evidence document. An entity lessee's documents are
 * served by the entity route; an individual lessee has no entity, so the
 * deal-scoped route serves them. Both write a DocumentAccessLog row.
 */
export function dealEvidenceUrl(deal: { dealId: string; entityId: string | null }, documentId: string): string {
  return deal.entityId
    ? `/api/asset-finance/entities/${deal.entityId}/documents/${documentId}`
    : `/api/asset-finance/deals/${deal.dealId}/documents/${documentId}`
}
