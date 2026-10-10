import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { DocumentRecord } from "@/lib/document-types"
import type { PortalKycChecklist } from "@/lib/kyc/portal-checklist"

vi.mock("@/components/documents/UploadDialog", () => ({
  UploadDialog: () => null,
}))
vi.mock("@/components/documents/DocumentPreviewDialog", () => ({
  DocumentPreviewDialog: () => null,
}))

import { PortalDocumentsClient } from "./PortalDocumentsClient"

function document(
  overrides: Partial<DocumentRecord> & Pick<DocumentRecord, "id" | "docType">,
): DocumentRecord {
  return {
    clientId: "client-1",
    fileUrl: "",
    fileName: `${overrides.docType.toLowerCase()}.pdf`,
    verified: false,
    uploadedByType: "CLIENT",
    uploadedById: null,
    deletedAt: null,
    fileSize: 1_024,
    mimeType: "application/pdf",
    extractionStatus: "done",
    extractionResult: null,
    extractionError: null,
    validationResult: null,
    validationMismatch: false,
    validationScore: null,
    biometricMatchScore: null,
    biometricLiveness: null,
    biometricVerifiedAt: null,
    biometricResult: null,
    verifiedAt: null,
    verifiedById: null,
    verificationNote: null,
    createdAt: "2026-07-23T06:00:00.000Z",
    ...overrides,
  }
}

function checklist(): PortalKycChecklist {
  return {
    complete: false,
    customerActionCount: 5,
    pendingReviewCount: 0,
    manualReviewHold: false,
    manualExceptionActive: false,
  substituteKind: null,
    coreDocuments: {
      ID_COPY: { documentId: "id-rejected", status: "action_required" },
      PROOF_OF_ADDRESS: { documentId: null, status: "missing" },
      PAYSLIP: { documentId: null, status: "missing" },
      BANK_STATEMENT: { documentId: null, status: "missing" },
    },
    selfie: {
      documentId: "selfie-failed",
      status: "action_required",
      reason: "extraction_incomplete",
      matchScore: null,
    },
    latestSelfieId: "selfie-failed",
  }
}

describe("PortalDocumentsClient KYC status consistency", () => {
  it("keeps rejected core and terminal selfie instructions consistent", () => {
    const html = renderToStaticMarkup(
      <PortalDocumentsClient
        clientId="client-1"
        popiaConsentGiven
        initialDocs={[
          document({
            id: "id-rejected",
            docType: "ID_COPY",
            verificationNote: "The image is unreadable",
          }),
          document({
            id: "selfie-failed",
            docType: "SELFIE",
            mimeType: "image/jpeg",
            fileName: "selfie.jpg",
            extractionStatus: "failed",
          }),
        ]}
        initialKycChecklist={checklist()}
      />,
    )

    expect(html).toContain(
      'data-document-id="id-rejected" data-document-status="Action needed"',
    )
    expect(html).toContain("The latest selfie could not be verified. Please retake it.")
    expect(html).not.toContain(
      "We couldn&#x27;t read this document automatically. Our team will review it manually.",
    )
  })

  it.each([
    ["id_document_portrait_invalid", "Please upload a new, clear photo of your ID, then retake your selfie."],
    ["selfie_not_real_photograph", "Your selfie could not be confirmed as a real, live photo of you."],
  ] as const)("tells the client the specific remedy for %s", (reason, remedy) => {
    const failedChecklist = checklist()
    failedChecklist.selfie = { ...failedChecklist.selfie, reason }
    const html = renderToStaticMarkup(
      <PortalDocumentsClient
        clientId="client-1"
        popiaConsentGiven
        initialDocs={[
          document({
            id: "selfie-failed",
            docType: "SELFIE",
            mimeType: "image/jpeg",
            fileName: "selfie.jpg",
            extractionStatus: "failed",
          }),
        ]}
        initialKycChecklist={failedChecklist}
      />,
    )

    expect(html).toContain(remedy)
    expect(html).not.toContain("The latest selfie could not be verified. Please retake it.")
  })

  it("renders a staff-rejected provider-passed selfie as customer action", () => {
    const rejectedSelfie = document({
      id: "selfie-staff-rejected",
      docType: "SELFIE",
      mimeType: "image/jpeg",
      fileName: "selfie.jpg",
      verified: false,
      verificationNote: "Identity mismatch requires a new capture",
      extractionStatus: "done",
      biometricMatchScore: 98,
    })
    const rejectedChecklist = checklist()
    rejectedChecklist.customerActionCount = 4
    rejectedChecklist.coreDocuments.ID_COPY = {
      documentId: null,
      status: "missing",
    }
    rejectedChecklist.selfie = {
      documentId: rejectedSelfie.id,
      status: "action_required",
      reason: "document_not_verified",
      matchScore: 98,
    }
    rejectedChecklist.latestSelfieId = rejectedSelfie.id

    const html = renderToStaticMarkup(
      <PortalDocumentsClient
        clientId="client-1"
        popiaConsentGiven
        initialDocs={[rejectedSelfie]}
        initialKycChecklist={rejectedChecklist}
      />,
    )

    expect(html).toContain(
      'data-document-id="selfie-staff-rejected" data-document-status="Action needed"',
    )
    expect(html).toContain("The latest selfie could not be verified. Please retake it.")
    expect(html).not.toContain("awaiting advisor review")
  })

  it("renders a senior exception as accepted but explicitly not biometric success", () => {
    const failedSelfie = document({
      id: "selfie-exception",
      docType: "SELFIE",
      mimeType: "image/jpeg",
      fileName: "selfie.jpg",
      extractionStatus: "failed",
      biometricMatchScore: 0,
    })
    const exceptionChecklist = checklist()
    exceptionChecklist.complete = true
    exceptionChecklist.customerActionCount = 0
    exceptionChecklist.manualExceptionActive = true
    for (const docType of Object.keys(exceptionChecklist.coreDocuments) as Array<
      keyof typeof exceptionChecklist.coreDocuments
    >) {
      exceptionChecklist.coreDocuments[docType] = {
        documentId: `doc-${docType}`,
        status: "verified",
      }
    }
    exceptionChecklist.selfie = {
      documentId: failedSelfie.id,
      status: "exception_accepted",
      reason: "face_not_detected",
      matchScore: 0,
    }
    exceptionChecklist.latestSelfieId = failedSelfie.id

    const html = renderToStaticMarkup(
      <PortalDocumentsClient
        clientId="client-1"
        popiaConsentGiven
        initialDocs={[failedSelfie]}
        initialKycChecklist={exceptionChecklist}
      />,
    )

    expect(html).toContain("senior manual KYC exception is active")
    expect(html).toContain("This is not a biometric pass")
    expect(html).toContain(
      'data-document-id="selfie-exception" data-document-status="Senior exception"',
    )
    expect(html).not.toContain("Please retake it")
  })
})
