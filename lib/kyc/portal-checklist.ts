import {
  CORE_KYC_DOCUMENT_TYPES,
  type CompositeKycResult,
  type CoreKycDocumentType,
} from "@/lib/kyc/document-state"
import { pendingIdReplacement } from "@/lib/kyc/id-replacement"

// A document with no createdAt (hand-built fixtures only) ties on time and is
// ordered by id.
const EPOCH = new Date(0)

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
  verificationRejectedAt?: Date | null
  /** Always present from the database read; selects the newest ID copy. */
  createdAt?: Date
  /** Always present from the database read; without it a copy is never identical. */
  contentSha256?: string | null
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
    /** Matched the client's current ID copy, which staff have yet to verify. */
    awaitingIdVerification: boolean
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
    // A verified ID copy is outweighed by a newer one awaiting review: point
    // at the newer copy, which is what is being reviewed. Chosen by the same
    // function the composite KYC derivation and the database rule mirror.
    const awaiting = docType === "ID_COPY"
      ? pendingIdReplacement(matching.map((document) => ({
          ...document,
          createdAt: document.createdAt ?? EPOCH,
        })))
      : null
    return awaiting
      ? { documentId: awaiting.id, status: "pending_review" }
      : { documentId: verified.id, status: "verified" }
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
      awaitingIdVerification: false,
    }
  }

  if (latest && composite.manualExceptionActive) {
    return {
      documentId: latest.id,
      status: "exception_accepted",
      reason,
      matchScore: latest.biometricMatchScore ?? null,
      awaitingIdVerification: false,
    }
  }

  if (latest && reason === null) {
    return {
      documentId: latest.id,
      status: "verified",
      reason,
      matchScore: latest.biometricMatchScore ?? null,
      awaitingIdVerification: false,
    }
  }

  if (!latest) {
    return {
      documentId: null,
      status: "missing",
      reason,
      matchScore: null,
      awaitingIdVerification: false,
    }
  }

  const extractionInProgress =
    reason === "extraction_incomplete" &&
    (latest.extractionStatus === "pending" ||
      latest.extractionStatus === "processing")
  const staffRejected = Boolean(latest.verificationNote?.trim())
  // Matched the ID copy staff have yet to review: a retake would match the
  // same copy again, so the client has nothing to do.
  const awaitingIdVerification = composite.biometricAwaitingIdVerification
  const pending = extractionInProgress ||
    (reason === "document_not_verified" && !staffRejected) ||
    awaitingIdVerification
  return {
    documentId: latest.id,
    status: pending ? "pending_review" : "action_required",
    reason,
    matchScore: latest.biometricMatchScore ?? null,
    awaitingIdVerification,
  }
}

/**
 * Project the customer checklist from the same composite KYC decision used by
 * review, approval, and disbursement. "Still needed" means the customer has
 * an action; uploaded evidence awaiting staff/provider review is not counted
 * as missing. Complete needs the STORED status VERIFIED as well: while staff
 * hold the client PENDING on complete evidence, the borrower sees it awaiting
 * the final decision, as staff see the stored status.
 */
export function derivePortalKycChecklist(args: {
  documents: readonly PortalChecklistDocument[]
  composite: CompositeKycResult
  storedKycStatus: string
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
    complete: args.composite.ok && args.storedKycStatus === "VERIFIED",
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
