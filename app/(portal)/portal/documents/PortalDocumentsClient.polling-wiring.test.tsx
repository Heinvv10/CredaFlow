import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DocumentRecord } from "@/lib/document-types"
import type { PortalKycChecklist } from "@/lib/kyc/portal-checklist"

const hooks = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  sync: vi.fn(),
  reconcile: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react")
  return {
    ...actual,
    useState: vi.fn((initial: unknown) => [
      typeof initial === "function"
        ? (initial as () => unknown)()
        : initial,
      vi.fn(),
    ]),
    useRef: vi.fn((initial: unknown) => ({ current: initial })),
    useCallback: vi.fn((callback: unknown) => callback),
    useEffect: vi.fn((effect: () => void | (() => void)) => {
      const cleanup = effect()
      if (cleanup) hooks.cleanups.push(cleanup)
    }),
  }
})

vi.mock("@/lib/kyc/portal-document-poller", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/kyc/portal-document-poller")
  >("@/lib/kyc/portal-document-poller")
  return {
    ...actual,
    PortalDocumentPoller: class {
      sync = hooks.sync
      reconcile = hooks.reconcile
      dispose = hooks.dispose
    },
  }
})

import { PortalDocumentsClient } from "./PortalDocumentsClient"

const pendingDocument: DocumentRecord = {
  id: "doc-existing-pending",
  clientId: "client-1",
  docType: "BANK_STATEMENT",
  fileUrl: "",
  fileName: "bank.pdf",
  verified: false,
  uploadedByType: "CLIENT",
  uploadedById: null,
  deletedAt: null,
  fileSize: 1_024,
  mimeType: "application/pdf",
  extractionStatus: "processing",
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
}

const checklist: PortalKycChecklist = {
  complete: false,
  customerActionCount: 4,
  pendingReviewCount: 1,
  manualReviewHold: false,
  manualExceptionActive: false,
  substituteKind: null,
  coreDocuments: {
    ID_COPY: { documentId: null, status: "missing" },
    PROOF_OF_ADDRESS: { documentId: null, status: "missing" },
    PAYSLIP: { documentId: null, status: "missing" },
    BANK_STATEMENT: {
      documentId: pendingDocument.id,
      status: "pending_review",
    },
  },
  selfie: {
    documentId: null,
    status: "missing",
    reason: "biometric_evidence_missing",
    matchScore: null,
    awaitingIdVerification: false,
  },
  latestSelfieId: null,
}

describe("PortalDocumentsClient polling wiring", () => {
  beforeEach(() => {
    hooks.cleanups.length = 0
    hooks.sync.mockReset()
    hooks.reconcile.mockReset()
    hooks.dispose.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("syncs initially pending documents and disposes its poller on unmount", () => {
    PortalDocumentsClient({
      clientId: "client-1",
      popiaConsentGiven: true,
      initialDocs: [pendingDocument],
      initialKycChecklist: checklist,
    })

    expect(hooks.sync).toHaveBeenCalledWith([pendingDocument])

    for (const cleanup of hooks.cleanups) cleanup()
    expect(hooks.dispose).toHaveBeenCalledTimes(1)
  })

  it("starts ID-independent reconciliation after an upload", () => {
    const tree = PortalDocumentsClient({
      clientId: "client-1",
      popiaConsentGiven: true,
      initialDocs: [pendingDocument],
      initialKycChecklist: checklist,
    })

    const findUploadComplete = (node: unknown): (() => void) | null => {
      if (!node || typeof node !== "object") return null
      const props = (node as {
        props?: {
          onUploadComplete?: () => void
          children?: unknown
        }
      }).props
      if (typeof props?.onUploadComplete === "function") {
        return props.onUploadComplete
      }
      const children = props?.children
      if (Array.isArray(children)) {
        for (const child of children) {
          const found = findUploadComplete(child)
          if (found) return found
        }
        return null
      }
      return findUploadComplete(children)
    }

    const onUploadComplete = findUploadComplete(tree)
    expect(onUploadComplete).not.toBeNull()
    onUploadComplete?.()
    expect(hooks.reconcile).toHaveBeenCalledTimes(1)
  })

  it("reconciles authoritative documents and KYC state after deletion", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("confirm", vi.fn(() => true))
    vi.stubGlobal("fetch", request)
    const tree = PortalDocumentsClient({
      clientId: "client-1",
      popiaConsentGiven: true,
      initialDocs: [pendingDocument],
      initialKycChecklist: checklist,
    })

    const findDelete = (
      node: unknown,
    ): (() => void | Promise<void>) | null => {
      if (!node || typeof node !== "object") return null
      const props = (node as {
        props?: {
          "aria-label"?: string
          onClick?: () => void | Promise<void>
          children?: unknown
        }
      }).props
      if (
        props?.["aria-label"] === "Delete Bank Statement" &&
        typeof props.onClick === "function"
      ) {
        return props.onClick
      }
      const children = props?.children
      if (Array.isArray(children)) {
        for (const child of children) {
          const found = findDelete(child)
          if (found) return found
        }
        return null
      }
      return findDelete(children)
    }

    const onDelete = findDelete(tree)
    expect(onDelete).not.toBeNull()
    await onDelete?.()

    expect(request).toHaveBeenCalledWith(
      `/api/documents/${pendingDocument.id}`,
      { method: "DELETE" },
    )
    expect(hooks.reconcile).toHaveBeenCalledTimes(1)
  })
})
