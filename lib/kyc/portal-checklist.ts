import {
  CORE_KYC_DOCUMENT_TYPES,
  type CompositeKycResult,
  type CoreKycDocumentType,
} from "@/lib/kyc/document-state"

export type PortalKycItemStatus =
  | "missing"
  | "pending_review"
  | "verified"
  | "exception_accepted"
  // No selfie was ever captured; identity was attested in person by staff.
  // Distinct from exception_accepted, which means a capture failed.
  | "verified_in_person"
  | "action_required"

export interface PortalChecklistDocument {
  id: string
  docType: string
  verified: boolean
  verificationNote: string | null
  /** Set only when a named reviewer refused it; null for a system re-flag. */
  verificationRejectedById?: string | null
  validationMismatch?: boolean
  biometricMatchScore?: number | null
  extractionStatus?: string
}

export interface PortalKycChecklistItem {
  documentId: string | null
  status: PortalKycItemStatus
}

export interface PortalKycChecklist {
  complete: boolean
  customerActionCount: number
  pendingReviewCount: number
  manualReviewHold: boolean
  manualExceptionActive: boolean
  substituteKind: CompositeKycResult["substituteKind"]
  coreDocuments: Record<CoreKycDocumentType, PortalKycChecklistItem>
  selfie: PortalKycChecklistItem & {
    reason: CompositeKycResult["biometricEvidence"]
    matchScore: number | null
  }
  latestSelfieId: string | null
}

function coreDocumentItem(
  documents: readonly PortalChecklistDocument[],
  docType: CoreKycDocumentType,
): PortalKycChecklistItem {
  const matching = documents.filter((document) => document.docType === docType)
  const verified = matching.find((document) => document.verified)
  if (verified) {
    return { documentId: verified.id, status: "verified" }
  }

  const current = matching[0]
  if (!current) {
    return { documentId: null, status: "missing" }
  }

  // A note alone is not the client's problem. The SYSTEM writes one when a
  // bank-detail change re-flags a statement (app/api/clients/[id]/route.ts),
  // and telling the client to replace a document that is fine sends them to
  // redo work when the real remedy is staff re-verifying it. Only a named
  // reviewer's refusal, or data that contradicts their record, needs them.
  const rejected = Boolean(current.verificationRejectedById) ||
    current.validationMismatch === true
  return {
    documentId: current.id,
    status: rejected ? "action_required" : "pending_review",
  }
}

function selfieItem(
  documents: readonly PortalChecklistDocument[],
  composite: CompositeKycResult,
  latestSelfieId: string | null,
): PortalKycChecklist["selfie"] {
  const latest = latestSelfieId
    ? documents.find((document) => document.id === latestSelfieId)
    : undefined
  const reason = composite.biometricEvidence

  // Attested in person: there is no selfie to point at, and asking the client
  // to take one would contradict the completed checklist.
  if (composite.substituteKind === "in_person") {
    return {
      documentId: null,
      status: "verified_in_person",
      reason: null,
      matchScore: null,
    }
  }

  if (latest && composite.manualExceptionActive) {
    return {
      documentId: latest.id,
      status: "exception_accepted",
      reason,
      matchScore: latest.biometricMatchScore ?? null,
    }
  }

  if (latest && reason === null) {
    return {
      documentId: latest.id,
      status: "verified",
      reason,
      matchScore: latest.biometricMatchScore ?? null,
    }
  }

  if (!latest) {
    return {
      documentId: null,
      status: "missing",
      reason,
      matchScore: null,
    }
  }

  const extractionInProgress =
    reason === "extraction_incomplete" &&
    (latest.extractionStatus === "pending" ||
      latest.extractionStatus === "processing")
  const staffRejected = Boolean(latest.verificationNote?.trim())
  const pending = extractionInProgress ||
    (reason === "document_not_verified" && !staffRejected)
  return {
    documentId: latest.id,
    status: pending ? "pending_review" : "action_required",
    reason,
    matchScore: latest.biometricMatchScore ?? null,
  }
}

/**
 * Project the customer checklist from the same composite KYC decision used by
 * review, approval, and disbursement. "Still needed" means the customer has
 * an action; uploaded evidence awaiting staff/provider review is not counted
 * as missing.
 */
export function derivePortalKycChecklist(args: {
  documents: readonly PortalChecklistDocument[]
  composite: CompositeKycResult
  latestSelfieId: string | null
}): PortalKycChecklist {
  const coreDocuments = Object.fromEntries(
    CORE_KYC_DOCUMENT_TYPES.map((docType) => [
      docType,
      coreDocumentItem(args.documents, docType),
    ]),
  ) as Record<CoreKycDocumentType, PortalKycChecklistItem>
  const selfie = selfieItem(
    args.documents,
    args.composite,
    args.latestSelfieId,
  )
  const items = [...Object.values(coreDocuments), selfie]

  return {
    complete: args.composite.ok,
    customerActionCount: items.filter(
      (item) => item.status === "missing" || item.status === "action_required",
    ).length,
    pendingReviewCount: items.filter(
      (item) => item.status === "pending_review",
    ).length,
    manualReviewHold: args.composite.manualRejectionActive,
    manualExceptionActive: args.composite.manualExceptionActive,
    substituteKind: args.composite.substituteKind,
    coreDocuments,
    selfie,
    latestSelfieId: args.latestSelfieId,
  }
}
