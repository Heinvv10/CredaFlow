import type { LoanPurposeCategory } from "@prisma/client"
import type { ApplicationSubmissionTransaction } from "@/lib/applications/submission-lock"

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

/**
 * Every create path asks this. One that collects the facts enforces them
 * (portal: POST /api/portal/applications; staff and lender API:
 * prepareApplicationFields); one that cannot (website enquiry, lead
 * conversion) refuses to create a PO_FUNDING application.
 */
export function requiresPoFundingFacts(productType: string | null | undefined): boolean {
  return productType === "PO_FUNDING"
}

/** What a create path that cannot collect the order says instead. */
export const PO_FUNDING_NEEDS_ORDER =
  "Purchase order funding needs the purchase order (number, buyer and document). Apply through the client portal or capture it on the application."

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

/**
 * The uploaded order is this client's own, undeleted PO document in this
 * tenant. Call it inside the create transaction after the client-evidence
 * lock, so a concurrent delete cannot slip between the check and the insert.
 */
export async function isClientPoDocument(
  db: Pick<ApplicationSubmissionTransaction, "clientDocument">,
  a: { tenantId: string; clientId: string; documentId: string },
): Promise<boolean> {
  const doc = await db.clientDocument.findFirst({
    where: { id: a.documentId, tenantId: a.tenantId, clientId: a.clientId, docType: "PO_DOCUMENT", deletedAt: null },
    select: { id: true },
  })
  return doc !== null
}
