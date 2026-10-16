import type { LoanPurposeCategory } from "@prisma/client"
import type { prisma } from "@/lib/prisma"

/**
 * Purchase-order funding is business credit: the advance pays a supplier for
 * a confirmed purchase order and is repaid from the buyer's payment. So a
 * PO_FUNDING application must name a business purpose and the order itself —
 * its number, the buyer, and the order document — and never a consumer
 * purpose (medical, funeral, …). Fair Score audit: the portal took a PO
 * application from a salaried individual with none of these.
 */
export interface PoFundingFacts {
  poNumber: string
  poBuyerName: string
  poDocumentId: string
}

export const PO_FUNDING_PURPOSE: LoanPurposeCategory = "BUSINESS"

type Parsed = { ok: true; facts: PoFundingFacts } | { ok: false; error: string }

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")

export function parsePoFundingFacts(body: Record<string, unknown>, category: LoanPurposeCategory | null): Parsed {
  if (category !== PO_FUNDING_PURPOSE) {
    return { ok: false, error: "Purchase order funding is for a business: choose the Business purpose." }
  }
  const poNumber = text(body.poNumber)
  const poBuyerName = text(body.poBuyerName)
  const poDocumentId = text(body.poDocumentId)
  if (poNumber.length < 1 || poNumber.length > 64) {
    return { ok: false, error: "Enter the purchase order number (up to 64 characters)." }
  }
  if (poBuyerName.length < 2 || poBuyerName.length > 200) {
    return { ok: false, error: "Enter the name of the buyer who issued the purchase order." }
  }
  if (!poDocumentId) {
    return { ok: false, error: "Upload the purchase order document." }
  }
  return { ok: true, facts: { poNumber, poBuyerName, poDocumentId } }
}

/** The uploaded order is this client's own PO document in this tenant. */
export async function isClientPoDocument(
  db: Pick<typeof prisma, "clientDocument">,
  a: { tenantId: string; clientId: string; documentId: string },
): Promise<boolean> {
  const doc = await db.clientDocument.findFirst({
    where: { id: a.documentId, tenantId: a.tenantId, clientId: a.clientId, docType: "PO_DOCUMENT" },
    select: { id: true },
  })
  return doc !== null
}
