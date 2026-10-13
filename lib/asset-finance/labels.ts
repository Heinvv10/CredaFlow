import type { BusinessEntityType, EntityDocumentType, EntityRole } from "@prisma/client"

// Display labels for the asset-finance enums, shared by staff and portal UI.

export const ENTITY_TYPE_LABELS: Record<BusinessEntityType, string> = {
  COMPANY: "Company (Pty) Ltd",
  CC: "Close corporation",
  TRUST: "Trust",
  PARTNERSHIP: "Partnership",
}

export const ENTITY_ROLE_LABELS: Record<EntityRole, string> = {
  DIRECTOR: "Director",
  MEMBER: "Member / partner",
  TRUSTEE: "Trustee",
  AUTHORISED_SIGNATORY: "Authorised signatory",
  SURETY: "Surety",
  BENEFICIAL_OWNER: "Beneficial owner",
}

export const ENTITY_DOCUMENT_LABELS: Record<EntityDocumentType, string> = {
  CIPC_REGISTRATION: "CIPC registration (CoR)",
  TRUST_DEED: "Trust deed",
  LETTERS_OF_AUTHORITY: "Letters of Authority",
  RESOLUTION: "Resolution",
  AFS: "Annual financial statements",
  MANAGEMENT_ACCOUNTS: "Management accounts",
  BANK_STATEMENT: "Bank statement",
  SUPPLIER_INVOICE: "Supplier invoice",
  INSURANCE_NOTING: "Insurance noting",
  TRACKER_CERTIFICATE: "Tracker certificate",
  DELIVERY_ACCEPTANCE: "Delivery and acceptance",
  NATIS_DOCUMENT: "eNaTIS document",
  VALUATION: "Valuation",
  SIGNED_AGREEMENT: "Signed agreement",
  SIGNED_SURETYSHIP: "Signed suretyship",
  SIGNED_RESOLUTION: "Signed resolution",
  OTHER: "Other",
}

/** "UNDER_REVIEW" → "Under review". */
export function statusLabel(status: string): string {
  const words = status.toLowerCase().replaceAll("_", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}
