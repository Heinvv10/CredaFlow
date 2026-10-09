import { describe, expect, it } from "vitest"
import type { CompositeKycResult } from "@/lib/kyc/document-state"
import { derivePortalKycChecklist } from "@/lib/kyc/portal-checklist"

function composite(
  overrides: Partial<CompositeKycResult> = {},
): CompositeKycResult {
  return {
    ok: false,
    state: {
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    },
    missingCoreDocuments: [],
    coreDocumentGaps: [],
    biometricEvidence: "document_not_verified",
    manualRejectionActive: false,
    okForOrigination: false,
    biometricAttemptFailed: false,
    substituteKind: null,
    manualExceptionActive: false,
    manualException: null,
    inPersonVerification: null,
    ...overrides,
  }
}

const uploadedCoreDocuments = [
  "ID_COPY",
  "PROOF_OF_ADDRESS",
  "PAYSLIP",
  "BANK_STATEMENT",
].map((docType) => ({
  id: `doc-${docType}`,
  docType,
  verified: false,
  verificationNote: null,
  validationMismatch: false,
}))

describe("derivePortalKycChecklist", () => {
  it("asks the client to act only when a named reviewer refused their document", () => {
    // The portal renders action_required as "This document needs attention.
    // Please replace it." A note alone does not justify that: the SYSTEM writes
    // one when a bank-detail change re-flags a statement, and the remedy there
    // is staff re-verifying it, not the client redoing work.
    const refused = derivePortalKycChecklist({
      documents: [
        ...uploadedCoreDocuments.filter((d) => d.docType !== "BANK_STATEMENT"),
        {
          id: "doc-BANK_STATEMENT",
          docType: "BANK_STATEMENT",
          verified: false,
          verificationNote: "Statement is illegible",
          verificationRejectedById: "officer-1",
          validationMismatch: false,
        },
      ],
      composite: composite(),
      latestSelfieId: null,
    })
    expect(refused.coreDocuments.BANK_STATEMENT.status).toBe("action_required")

    const systemReflagged = derivePortalKycChecklist({
      documents: [
        ...uploadedCoreDocuments.filter((d) => d.docType !== "BANK_STATEMENT"),
        {
          id: "doc-BANK_STATEMENT",
          docType: "BANK_STATEMENT",
          verified: false,
          verificationNote: "Bank details changed; verify this document against the current account before disbursement.",
          verificationRejectedById: null,
          validationMismatch: false,
        },
      ],
      composite: composite(),
      latestSelfieId: null,
    })
    expect(systemReflagged.coreDocuments.BANK_STATEMENT.status).toBe("pending_review")
  })

  it("still asks the client to act when their document contradicts their record", () => {
    // validationMismatch IS the client's to fix, regardless of who noted it.
    const result = derivePortalKycChecklist({
      documents: [
        ...uploadedCoreDocuments.filter((d) => d.docType !== "PAYSLIP"),
        {
          id: "doc-PAYSLIP",
          docType: "PAYSLIP",
          verified: false,
          verificationNote: null,
          verificationRejectedById: null,
          validationMismatch: true,
        },
      ],
      composite: composite(),
      latestSelfieId: null,
    })
    expect(result.coreDocuments.PAYSLIP.status).toBe("action_required")
  })

  it("does not call uploaded evidence still needed while advisor review is pending", () => {
    const result = derivePortalKycChecklist({
      documents: [
        ...uploadedCoreDocuments,
        {
          id: "selfie-current",
          docType: "SELFIE",
          verified: false,
          verificationNote: null,
          extractionStatus: "processing",
          biometricMatchScore: 98,
        },
      ],
      composite: composite(),
      latestSelfieId: "selfie-current",
    })

    expect(result.customerActionCount).toBe(0)
    expect(result.pendingReviewCount).toBe(5)
    expect(result.coreDocuments.ID_COPY.status).toBe("pending_review")
    expect(result.selfie.status).toBe("pending_review")
  })

  it("requires customer action when selfie extraction ended without evidence", () => {
    const result = derivePortalKycChecklist({
      documents: [
        ...uploadedCoreDocuments,
        {
          id: "selfie-terminal-failure",
          docType: "SELFIE",
          verified: false,
          verificationNote: null,
          extractionStatus: "failed",
          biometricMatchScore: null,
        },
      ],
      composite: composite({
        biometricEvidence: "extraction_incomplete",
        state: {
          kycStatus: "FAILED",
          kycVerifiedAt: null,
          kycVerifiedById: null,
          kycVerificationMethod: null,
        },
      }),
      latestSelfieId: "selfie-terminal-failure",
    })

    expect(result.selfie.status).toBe("action_required")
    expect(result.customerActionCount).toBe(1)
    expect(result.pendingReviewCount).toBe(4)
  })

  it("requires action when staff rejected an otherwise provider-passed selfie", () => {
    const result = derivePortalKycChecklist({
      documents: [
        ...uploadedCoreDocuments.map((document) => ({
          ...document,
          verified: true,
        })),
        {
          id: "selfie-staff-rejected",
          docType: "SELFIE",
          verified: false,
          verificationNote: "Identity mismatch requires a new capture",
          extractionStatus: "done",
          biometricMatchScore: 98,
        },
      ],
      composite: composite({
        biometricEvidence: "document_not_verified",
        state: {
          kycStatus: "PENDING",
          kycVerifiedAt: null,
          kycVerifiedById: null,
          kycVerificationMethod: null,
        },
      }),
      latestSelfieId: "selfie-staff-rejected",
    })

    expect(result.selfie).toEqual({
      documentId: "selfie-staff-rejected",
      status: "action_required",
      reason: "document_not_verified",
      matchScore: 98,
    })
    expect(result.customerActionCount).toBe(1)
    expect(result.pendingReviewCount).toBe(0)
  })

  it("never treats match score alone as verified biometric evidence", () => {
    const result = derivePortalKycChecklist({
      documents: [
        ...uploadedCoreDocuments.map((document) => ({
          ...document,
          verified: true,
        })),
        {
          id: "selfie-current",
          docType: "SELFIE",
          verified: true,
          verificationNote: null,
          biometricMatchScore: 99,
        },
      ],
      composite: composite({
        biometricEvidence: "vlm_liveness_failed",
        state: {
          kycStatus: "FAILED",
          kycVerifiedAt: null,
          kycVerifiedById: null,
          kycVerificationMethod: null,
        },
      }),
      latestSelfieId: "selfie-current",
    })

    expect(result.complete).toBe(false)
    expect(result.selfie.status).toBe("action_required")
    expect(result.selfie.reason).toBe("vlm_liveness_failed")
    expect(result.customerActionCount).toBe(1)
  })

  it("uses the authoritative latest attempt instead of an older valid selfie", () => {
    const result = derivePortalKycChecklist({
      documents: [
        ...uploadedCoreDocuments.map((document) => ({
          ...document,
          verified: true,
        })),
        {
          id: "selfie-older",
          docType: "SELFIE",
          verified: true,
          verificationNote: null,
          biometricMatchScore: 98,
        },
        {
          id: "selfie-latest",
          docType: "SELFIE",
          verified: false,
          verificationNote: null,
          biometricMatchScore: 12,
        },
      ],
      composite: composite({
        biometricEvidence: "match_score_below_threshold",
        state: {
          kycStatus: "FAILED",
          kycVerifiedAt: null,
          kycVerifiedById: null,
          kycVerificationMethod: null,
        },
      }),
      latestSelfieId: "selfie-latest",
    })

    expect(result.selfie.documentId).toBe("selfie-latest")
    expect(result.selfie.status).toBe("action_required")
  })

  it("reports complete only when the composite KYC evaluator passes", () => {
    const result = derivePortalKycChecklist({
      documents: [
        ...uploadedCoreDocuments.map((document) => ({
          ...document,
          verified: true,
        })),
        {
          id: "selfie-current",
          docType: "SELFIE",
          verified: true,
          verificationNote: null,
          biometricMatchScore: 96,
        },
      ],
      composite: composite({
        ok: true,
        biometricEvidence: null,
        state: {
          kycStatus: "VERIFIED",
          kycVerifiedAt: new Date("2026-07-23T03:00:00.000Z"),
          kycVerifiedById: null,
          kycVerificationMethod: "SMILE_IDENTITY",
        },
      }),
      latestSelfieId: "selfie-current",
    })

    expect(result.complete).toBe(true)
    expect(result.customerActionCount).toBe(0)
    expect(result.pendingReviewCount).toBe(0)
    expect(result.selfie.status).toBe("verified")
  })

  it("shows a senior exception as distinct from biometric verification", () => {
    const result = derivePortalKycChecklist({
      documents: [
        ...uploadedCoreDocuments.map((document) => ({
          ...document,
          verified: true,
        })),
        {
          id: "selfie-current",
          docType: "SELFIE",
          verified: false,
          verificationNote: null,
          extractionStatus: "failed",
          biometricMatchScore: 0,
        },
      ],
      composite: composite({
        ok: true,
        biometricEvidence: "face_not_detected",
        manualExceptionActive: true,
        manualException: {
          kind: "KYC_MANUAL_EXCEPTION",
          version: "manual-kyc-exception-v1",
          clientId: "client-1",
          documentId: "selfie-current",
          documentSha256: "a".repeat(64),
          subjectFingerprint: "b".repeat(64),
          biometricFailureReason: "face_not_detected",
          reason: "Senior accepted physical identity evidence after review.",
          supportingEvidence: "ID copy and physical comparison were reviewed.",
          approvedAt: "2026-07-23T03:00:00.000Z",
          approvedById: "admin-1",
          approvedByEmail: "admin@example.test",
        },
        state: {
          kycStatus: "VERIFIED",
          kycVerifiedAt: new Date("2026-07-23T03:00:00.000Z"),
          kycVerifiedById: "admin-1",
          kycVerificationMethod: "PHYSICAL",
        },
      }),
      latestSelfieId: "selfie-current",
    })

    expect(result.complete).toBe(true)
    expect(result.customerActionCount).toBe(0)
    expect(result.manualExceptionActive).toBe(true)
    expect(result.selfie).toEqual({
      documentId: "selfie-current",
      status: "exception_accepted",
      reason: "face_not_detected",
      matchScore: 0,
    })
  })

  it("keeps a manual-review hold visible even when all evidence is valid", () => {
    const result = derivePortalKycChecklist({
      documents: [
        ...uploadedCoreDocuments.map((document) => ({
          ...document,
          verified: true,
        })),
        {
          id: "selfie-current",
          docType: "SELFIE",
          verified: true,
          verificationNote: null,
          biometricMatchScore: 96,
        },
      ],
      composite: composite({
        biometricEvidence: null,
        manualRejectionActive: true,
        state: {
          kycStatus: "FAILED",
          kycVerifiedAt: null,
          kycVerifiedById: null,
          kycVerificationMethod: null,
        },
      }),
      latestSelfieId: "selfie-current",
    })

    expect(result.complete).toBe(false)
    expect(result.manualReviewHold).toBe(true)
    expect(result.selfie.status).toBe("verified")
  })
})
