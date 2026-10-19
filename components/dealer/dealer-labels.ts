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

export const COMMISSION_REASON_LABELS: Record<string, string> = {
  LOAN_SETTLED_EARLY: "Settled early",
  LOAN_WRITTEN_OFF: "Written off",
  LOAN_CANCELLED: "Cancelled",
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
