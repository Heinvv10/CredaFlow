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
      awaitingIdVerification: false,
    },
    latestSelfieId: "selfie-failed",
  }
}

describe("PortalDocumentsClient: Superseded only marks an older replaced copy", () => {
  const stale = document({ id: "id-stale", docType: "ID_COPY", createdAt: "2026-07-20T06:00:00.000Z" })
  const verifiedOld = document({
    id: "id-verified",
    docType: "ID_COPY",
    verified: true,
    createdAt: "2026-07-21T06:00:00.000Z",
  })

  function render(newest: DocumentRecord, checklistId: string, status: "pending_review" | "verified") {
    const withNewest = checklist()
    withNewest.coreDocuments.ID_COPY = { documentId: checklistId, status }
    return renderToStaticMarkup(
      <PortalDocumentsClient
        clientId="client-1"
        popiaConsentGiven
        initialDocs={[newest, verifiedOld, stale]}
        initialKycChecklist={withNewest}
      />,
    )
  }

  it("shows the newest unverified ID as pending review, not Superseded", () => {
    const newest = document({ id: "id-newest", docType: "ID_COPY", createdAt: "2026-07-22T06:00:00.000Z" })
    const html = render(newest, "id-newest", "pending_review")

    expect(html).toContain('data-document-id="id-newest" data-document-status="Pending review"')
    expect(html).toContain('data-document-id="id-verified" data-document-status="Verified"')
    expect(html).toContain('data-document-id="id-stale" data-document-status="Superseded"')
  })

  it("does not label a newest unverified ID Superseded even when the checklist still names the verified copy", () => {
    const newest = document({ id: "id-newest", docType: "ID_COPY", createdAt: "2026-07-22T06:00:00.000Z" })
    const html = render(newest, "id-verified", "verified")

    expect(html).toContain('data-document-id="id-newest" data-document-status="Pending review"')
    expect(html).toContain('data-document-id="id-stale" data-document-status="Superseded"')
  })

  it("shows a newest ID a reviewer refused as needing action", () => {
    const newest = document({
      id: "id-newest",
      docType: "ID_COPY",
      createdAt: "2026-07-22T06:00:00.000Z",
      verificationRejectedById: "officer-1",
    })
    const html = render(newest, "id-verified", "verified")

    expect(html).toContain('data-document-id="id-newest" data-document-status="Action needed"')
  })
})

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
    ["id_document_portrait_invalid", "please upload a new, clear photo of your ID, then retake your selfie."],
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
      awaitingIdVerification: false,
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

  it("tells the client a selfie matched against an ID copy awaiting verification needs no retake", () => {
    const idCopy = document({ id: "id-awaiting", docType: "ID_COPY" })
    const matchedSelfie = document({
      id: "selfie-matched",
      docType: "SELFIE",
      mimeType: "image/jpeg",
      fileName: "selfie.jpg",
      verified: true,
      extractionStatus: "done",
      biometricMatchScore: 90,
    })
    const awaitingChecklist = checklist()
    awaitingChecklist.customerActionCount = 3
    awaitingChecklist.pendingReviewCount = 2
    awaitingChecklist.coreDocuments.ID_COPY = { documentId: idCopy.id, status: "pending_review" }
    awaitingChecklist.selfie = {
      documentId: matchedSelfie.id,
      status: "pending_review",
      reason: "subject_identity_changed",
      matchScore: 90,
      awaitingIdVerification: true,
    }
    awaitingChecklist.latestSelfieId = matchedSelfie.id

    const html = renderToStaticMarkup(
      <PortalDocumentsClient
        clientId="client-1"
        popiaConsentGiven
        initialDocs={[idCopy, matchedSelfie]}
        initialKycChecklist={awaitingChecklist}
      />,
    )
    const decoded = html.replaceAll("&#x27;", "'")

    // Once on the checklist row, once on the document row.
    expect(decoded.split(
      "Selfie received. We're checking your ID document — your identity check completes as soon as it's verified. You don't need to retake your selfie.",
    )).toHaveLength(3)
    expect(html).toContain(
      'data-document-id="selfie-matched" data-document-status="Pending review"',
    )
    expect(html).not.toContain("The latest selfie could not be verified")
    expect(html).not.toContain("Retake")
    expect(html).not.toContain("Verification is running")
    expect(html).not.toContain("Verifying your identity")
    // The checklist row's pill: not "Action needed", not "Verifying".
    const selfieRow = html.slice(html.indexOf("Selfie verification"), html.indexOf("Upload another document"))
    expect(selfieRow).not.toContain("Action needed")
    expect(selfieRow).toContain("Pending review")
    // Nothing is running: staff have the next step, so no spinner anywhere.
    expect(html).not.toContain("animate-spin")
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
      awaitingIdVerification: false,
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
