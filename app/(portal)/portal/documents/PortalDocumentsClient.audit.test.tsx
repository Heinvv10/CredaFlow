import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { DocumentRecord } from "@/lib/document-types"
import type { PortalKycChecklist } from "@/lib/kyc/portal-checklist"

const h = vi.hoisted(() => ({ uploadProps: vi.fn() }))
vi.mock("@/components/documents/UploadDialog", () => ({ UploadDialog: (p: unknown) => { h.uploadProps(p); return null } }))
vi.mock("@/components/documents/DocumentPreviewDialog", () => ({ DocumentPreviewDialog: () => null }))

import { PortalDocumentsClient } from "./PortalDocumentsClient"

// Fair Score audit 2026-10-16, a returning client verified in person (Thembeka).

function doc(overrides: Partial<DocumentRecord> & Pick<DocumentRecord, "id" | "docType">): DocumentRecord {
  return {
    clientId: "client-1", fileUrl: "", fileName: "f.pdf", verified: true, uploadedByType: "CLIENT", uploadedById: null,
    deletedAt: null, fileSize: 1_024, mimeType: "application/pdf", extractionStatus: "done", extractionResult: null,
    extractionError: null, validationResult: null, validationMismatch: false, validationScore: null,
    biometricMatchScore: null, biometricLiveness: null, biometricVerifiedAt: null, biometricResult: null,
    verifiedAt: null, verifiedById: null, verificationNote: null, createdAt: "2026-04-10T06:00:00.000Z",
    ...overrides,
  }
}

function inPersonChecklist(): PortalKycChecklist {
  return {
    complete: true, customerActionCount: 0, pendingReviewCount: 0, manualReviewHold: false,
    manualExceptionActive: true, substituteKind: "in_person",
    coreDocuments: {
      ID_COPY: { documentId: "id", status: "verified" },
      PROOF_OF_ADDRESS: { documentId: "poa", status: "verified" },
      PAYSLIP: { documentId: "pay", status: "verified" },
      BANK_STATEMENT: { documentId: "bs", status: "verified" },
    },
    selfie: { documentId: null, status: "verified_in_person", reason: null, matchScore: null, awaitingIdVerification: false },
    latestSelfieId: null,
  }
}

const core = [
  doc({ id: "id", docType: "ID_COPY" }), doc({ id: "poa", docType: "PROOF_OF_ADDRESS" }),
  doc({ id: "pay", docType: "PAYSLIP" }), doc({ id: "bs", docType: "BANK_STATEMENT" }),
]

function render(docs: DocumentRecord[], recentStatementSince: string | null = null) {
  return renderToStaticMarkup(
    <PortalDocumentsClient clientId="client-1" popiaConsentGiven initialDocs={docs}
      initialKycChecklist={inPersonChecklist()} recentStatementSince={recentStatementSince} />,
  ).replace(/<!-- -->/g, "")
}

describe("documents page: identity verified in person", () => {
  it("shows the selfie row as not needed, with no REQUIRED pill and no Take selfie button", () => {
    const html = render(core)
    expect(html).toContain("Not needed")
    expect(html).not.toContain(">Required<")
    expect(html).not.toContain("Take selfie")
  })
})

describe("documents page: system-generated documents", () => {
  it.each(["CREDIT_AGREEMENT", "EXECUTED_CREDIT_AGREEMENT", "DEBIT_MANDATE", "FORM_20_PRE_AGREEMENT", "SIGNED_AGREEMENT_PACKET"])(
    "%s never shows the OCR could-not-read message", (docType) => {
      const html = render([...core, doc({ id: "gen", docType, extractionStatus: "skipped" })])
      expect(html).not.toContain("We couldn&#x27;t read this document automatically")
    },
  )

  it("a client upload that could not be read still says so", () => {
    const html = render([...core, doc({ id: "other", docType: "OTHER", extractionStatus: "failed" })])
    expect(html).toContain("We couldn&#x27;t read this document automatically")
  })
})

describe("documents page: an application that needs a recent statement", () => {
  it("asks for a statement instead of saying everything is complete", () => {
    const html = render(core, "2026-07-18T00:00:00.000Z")
    expect(html).toContain("Upload a recent bank statement")
    expect(html).not.toContain("All required documents are complete")
  })

  it("is satisfied by a statement uploaded inside the window", () => {
    const fresh = doc({ id: "bs2", docType: "BANK_STATEMENT", verified: false, createdAt: "2026-10-16T08:00:00.000Z" })
    const html = render([...core, fresh], "2026-07-18T00:00:00.000Z")
    expect(html).not.toContain("Upload a recent bank statement")
  })
})

describe("documents page: no camera on this device", () => {
  it("offers the selfie capture a continue-on-your-phone hand-off", () => {
    render(core)
    const props = h.uploadProps.mock.calls.at(-1)![0] as { selfieFallback?: { type?: { name?: string } } }
    expect(props.selfieFallback?.type?.name).toBe("ContinueOnPhone")
  })
})
