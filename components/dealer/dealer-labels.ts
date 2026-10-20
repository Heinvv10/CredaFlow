// Display helpers for the dealer portal. Client-safe: types only from the
// dealer libraries.
import type { EntityDocumentType } from "@prisma/client"
import type { DealerDealStatus } from "@/lib/dealer/deal-view"
import { ENTITY_DOCUMENT_LABELS } from "@/lib/asset-finance/labels"

export const DEALER_STATUS_TONE: Record<DealerDealStatus, "neutral" | "success" | "warning" | "danger" | "info"> = {
  Draft: "neutral",
  "In review": "info",
  Approved: "success",
  Signed: "success",
  Booked: "success",
  Declined: "danger",
  Cancelled: "neutral",
}

/** A commission line as the dealer reads it: never why a commission was reversed (the borrower's loan performance). */
export const COMMISSION_KIND_LABELS: Record<"EARNED" | "REVERSED", string> = {
  EARNED: "Earned",
  REVERSED: "Reversed (clawback)",
}

export const RUN_STATUS_LABELS: Record<string, string> = {
  PENDING_APPROVAL: "Awaiting approval",
  APPROVED: "Approved",
  RELEASED: "Paid",
  CANCELLED: "Cancelled",
}

/** "SUPPLIER_INVOICE_MATCHES_ASSET" → "Supplier invoice matches asset". */
export function humanise(code: string): string {
  const words = code.toLowerCase().split("_").join(" ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A projection "missing" item ("Document: AFS", "Checklist: X", "Consent: name") as the dealer reads it. */
export function missingLabel(item: string): string {
  const [kind, value] = [item.slice(0, item.indexOf(": ")), item.slice(item.indexOf(": ") + 2)]
  if (kind === "Document") return `Document: ${ENTITY_DOCUMENT_LABELS[value as EntityDocumentType] ?? humanise(value)}`
  if (kind === "Checklist") return `Lender check: ${humanise(value)}`
  return item
}
