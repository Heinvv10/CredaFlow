import type { EntityDocumentType } from "@prisma/client"

/** The document types a dealer uploads on its deals (client-safe: the portal's upload form lists them). */
export const DEALER_UPLOAD_DOC_TYPES = [
  "CIPC_REGISTRATION", "TRUST_DEED", "LETTERS_OF_AUTHORITY", "RESOLUTION", "AFS", "MANAGEMENT_ACCOUNTS", "BANK_STATEMENT",
  "SUPPLIER_INVOICE", "NATIS_DOCUMENT", "INSURANCE_NOTING", "POPIA_CONSENT", "OTHER",
] as const satisfies readonly EntityDocumentType[]
