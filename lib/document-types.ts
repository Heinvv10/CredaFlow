export const DOC_TYPE_LABELS: Record<string, string> = {
  ID_COPY: "ID Copy",
  PROOF_OF_ADDRESS: "Proof of Address",
  PAYSLIP: "Payslip",
  BANK_STATEMENT: "Bank Statement",
  SELFIE: "Selfie",
  PO_DOCUMENT: "PO Document",
  PROOF_OF_PAYMENT: "Proof of Payment",
  CREDIT_AGREEMENT: "Credit Agreement",
  // Named so a consumer can tell the two apart in their document list: one is
  // what they were shown, the other is what everyone signed.
  EXECUTED_CREDIT_AGREEMENT: "Signed Credit Agreement",
  DEBIT_MANDATE: "Debit Mandate",
  FORM_20_PRE_AGREEMENT: "Form 20 Pre-Agreement",
  // The PDF the consumer physically signed and returned, on the paper path.
  // Named for what it is rather than "Other", which is where it used to land.
  SIGNED_AGREEMENT_PACKET: "Signed Packet (returned)",
  OTHER: "Other",
}

/**
 * The types a human may upload by hand.
 *
 * CREDIT_AGREEMENT, DEBIT_MANDATE and FORM_20_PRE_AGREEMENT are deliberately
 * absent: the system GENERATES those and binds each to the application by
 * digest. The upload route already rejects them (`VALID_DOC_TYPES`, 400
 * "Invalid docType"), so offering them in a picker is a dead option — and not a
 * harmless one. They are exactly what someone holding a returned signed packet
 * reaches for instead of "Upload and Record Signed Packet", which leaves the
 * signed documents inert, never recorded against the application.
 *
 * DOC_TYPE_LABELS still carries all of them: generated documents must render a
 * label wherever they are LISTED. This list governs what may be CREATED.
 *
 * Must stay in sync with VALID_DOC_TYPES in lib/document-auth.ts. That module
 * imports prisma, so it cannot be pulled into a client component; a test
 * asserts the two agree rather than trusting this comment.
 */
export const UPLOADABLE_DOC_TYPES = [
  "ID_COPY",
  "PROOF_OF_ADDRESS",
  "PAYSLIP",
  "BANK_STATEMENT",
  "SELFIE",
  "PO_DOCUMENT",
  "PROOF_OF_PAYMENT",
  "OTHER",
] as const

/**
 * Generated, digest-bound, never hand-uploaded.
 *
 * SIGNED_AGREEMENT_PACKET is a staff upload, but it belongs here all the same:
 * it is created ONLY by POST /api/applications/[id]/signing-packet, which
 * digest-binds it to the exact PASQ and agreement it was issued against. The
 * generic upload route must keep refusing it — reaching for it in a picker is
 * how a signed packet ends up recorded against nothing.
 */
export const SYSTEM_GENERATED_DOC_TYPES = [
  "CREDIT_AGREEMENT",
  "EXECUTED_CREDIT_AGREEMENT",
  "DEBIT_MANDATE",
  "FORM_20_PRE_AGREEMENT",
  "SIGNED_AGREEMENT_PACKET",
] as const

/**
 * The types this upload path exists to collect. Uploading one of these while an
 * agreement is unsigned is ordinary KYC work, not a mis-filed signed contract.
 *
 * Lives here, not in the upload route, because BOTH ends need it and only this
 * module is client-safe: the route warns after the upload, the upload dialog
 * warns before it, and a returned signed packet that slips through one of them
 * binds to nothing. Two copies of this list would differ silently — the file
 * already carries one such drift as a lesson (UPLOADABLE_DOC_TYPES).
 */
export const CORE_KYC_UPLOAD_DOC_TYPES = [
  "ID_COPY",
  "BANK_STATEMENT",
  "PAYSLIP",
  "PROOF_OF_ADDRESS",
  "SELFIE",
] as const

/**
 * True when a document of this type, uploaded as a loose client document,
 * could be a returned signed agreement filed in the wrong place.
 *
 * Anything outside the core KYC set qualifies — not just "Other". Someone
 * holding a signed packet and finding no credit-agreement option reaches for
 * whichever row looks closest, and "PO Document" is as reachable as "Other".
 */
export function mayBeMisfiledSignedAgreement(docType: string): boolean {
  return (
    docType.length > 0
    && !(CORE_KYC_UPLOAD_DOC_TYPES as readonly string[]).includes(docType)
  )
}

export const REQUIRED_DOC_TYPES = [
  "ID_COPY",
  "PAYSLIP",
  "BANK_STATEMENT",
  "PROOF_OF_ADDRESS",
] as const

export interface DocumentRecord {
  id: string
  clientId: string
  docType: string
  fileUrl: string
  fileName: string
  verified: boolean
  /** Set only when a named reviewer refused the document; null for a system re-flag. */
  verificationRejectedById?: string | null
  /** Digest of the stored bytes; an identical ID re-upload shares it (lib/kyc/staff-checklist.ts). */
  contentSha256?: string | null
  uploadedByType: string
  uploadedById: string | null
  deletedAt: string | null
  fileSize: number | null
  mimeType: string | null
  extractionStatus: string
  /**
   * The lending read of the document. Absent (not null) for a viewer without
   * the loan book: LOAN_BOOK_DOCUMENT_FIELDS, lib/security/client-redaction.ts.
   */
  extractionResult?: Record<string, unknown> | null
  extractionError: string | null
  validationResult?: ValidationResult | null
  validationMismatch?: boolean
  validationScore?: number | null
  biometricMatchScore: number | null
  biometricLiveness: number | null
  biometricVerifiedAt: string | null
  biometricResult: Record<string, unknown> | null
  verifiedAt: string | null
  verifiedById: string | null
  verificationNote: string | null
  createdAt: string
}

export interface ValidationMismatch {
  field: string
  label: string
  documentValue: string | null
  recordValue: string | null
  severity: 'critical' | 'warning' | 'info'
  message: string
}

export interface ValidationResult {
  isValid: boolean
  matchScore: number
  mismatches: ValidationMismatch[]
  matches: string[]
}

export function formatFileSize(bytes: number | null): string {
  if (!bytes) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
