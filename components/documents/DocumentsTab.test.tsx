import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DocumentsTab } from "./DocumentsTab"
import type { DocumentRecord } from "@/lib/document-types"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

const baseDocument: DocumentRecord = {
  id: "doc-1",
  clientId: "client-1",
  docType: "FORM_20_PRE_AGREEMENT",
  fileUrl: "/uploads/document.pdf",
  fileName: "pasq-client-1.pdf",
  verified: false,
  uploadedByType: "staff",
  uploadedById: "officer-1",
  deletedAt: null,
  fileSize: 27_700,
  mimeType: "application/pdf",
  extractionStatus: "skipped",
  extractionResult: null,
  extractionError: "Automatic extraction failed",
  validationResult: {
    isValid: false,
    matchScore: 20,
    mismatches: [{
      field: "idNumber",
      label: "ID number",
      documentValue: "wrong",
      recordValue: "expected",
      severity: "critical",
      message: "ID number differs",
    }],
    matches: [],
  },
  validationMismatch: true,
  validationScore: 20,
  biometricMatchScore: null,
  biometricLiveness: null,
  biometricVerifiedAt: null,
  biometricResult: null,
  verifiedAt: null,
  verifiedById: null,
  verificationNote: null,
  createdAt: "2026-07-29T08:00:00.000Z",
}

function rendered(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON())
}

/**
 * DocumentsTab calls TWO endpoints. A single stub answering both with the
 * documents array fed that array to the packet card, which then rendered an
 * empty "Signing packet" shell with an undefined React key — and every
 * assertion below still passed. Route by URL so each endpoint gets its own
 * fixture and the card is only exercised deliberately.
 */
function stubFetch(docs: unknown[], packets: unknown[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    Response.json(String(url).includes("/signing-packets") ? packets : docs)))
}

const packet = (over: Record<string, unknown> = {}) => ({
  applicationId: "app-1",
  reference: "APP-0001",
  state: "awaiting_signature",
  downloadUrl: "/api/applications/app-1/signing-packet",
  documentId: null,
  headline: "Signing packet — awaiting signature",
  detail: "The PASQ and credit agreement as one packet, quotation first.",
  supersededReturnedPacket: false,
  unrecordedReturnedPacket: false,
  ...over,
})

describe("DocumentsTab generic document actions", () => {
  let renderer!: ReactTestRenderer

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  // The PASQ and the credit agreement are halves of one packet. Listing them as
  // ordinary downloadable cards is what led staff to email a 4-page half for
  // signature (2026-08-05) — the consumer signed it and the
  // upload was correctly refused for having 4 pages instead of 8.
  it("keeps the packet halves out of the main document list", async () => {
    stubFetch([baseDocument])

    await act(async () => {
      renderer = create(<DocumentsTab clientId="client-1" popiaConsentGiven />)
    })

    const markup = rendered(renderer)
    expect(markup).toContain("Signing packet components (")
    expect(markup).toContain("cannot be signed on its own")
    // Collapsed: the card itself is not rendered until asked for.
    expect(markup).not.toContain("pasq-client-1.pdf")
  })

  it("still reaches the halves, read-only, when the section is expanded", async () => {
    stubFetch([baseDocument])

    await act(async () => {
      renderer = create(<DocumentsTab clientId="client-1" popiaConsentGiven />)
    })

    // The disclosure is the only control carrying aria-expanded.
    const toggle = renderer.root.findAll(
      (node) => node.type === "button" && node.props["aria-expanded"] !== undefined,
    )[0]
    expect(toggle).toBeDefined()
    await act(async () => { toggle.props.onClick() })

    const markup = rendered(renderer)
    expect(markup).toContain("pasq-client-1.pdf")
    // Still read-only where it lives now: no verify/extract/delete affordances.
    expect(markup).toContain("Locked statutory evidence")
    expect(markup).not.toContain('"Delete"')
    expect(markup).not.toContain('"Verify"')
    expect(markup).toContain("Locked statutory evidence")
    expect(markup).not.toContain("Unverified")
    expect(markup).not.toContain("Document Mismatch")
    expect(markup).not.toContain("Override & Accept")
    expect(markup).not.toContain("Automatic extraction did not run")
    expect(markup).not.toContain('"Verify"')
    expect(markup).not.toContain('"Extract"')
    expect(markup).not.toContain('"Delete"')
    expect(markup).toContain('"View"')
  })

  // The empty state counts the MAIN list, not the folder. A client whose only
  // documents are the two halves would otherwise get a blank grid with no
  // explanation while the content sits in the section below it.
  it("shows the empty state when every document is a packet half", async () => {
    stubFetch([
      baseDocument,
      { ...baseDocument, id: "doc-2", docType: "CREDIT_AGREEMENT", fileName: "ca.pdf" },
    ])

    await act(async () => {
      renderer = create(<DocumentsTab clientId="client-1" popiaConsentGiven />)
    })

    const markup = rendered(renderer)
    expect(markup).toContain("No documents uploaded yet")
    expect(markup).toContain("Signing packet components (")
  })

  it("preserves the generic workflow for an ordinary document", async () => {
    stubFetch([{
      ...baseDocument,
      docType: "BANK_STATEMENT",
      fileName: "bank-statement.pdf",
    }])

    await act(async () => {
      renderer = create(
        <DocumentsTab clientId="client-1" popiaConsentGiven />,
      )
    })

    const markup = rendered(renderer)
    expect(markup).toContain("Unverified")
    expect(markup).toContain("Document Mismatch")
    expect(markup).toContain("Override & Accept")
    expect(markup).toContain("Automatic extraction did not run")
    expect(markup).toContain('"Verify"')
    expect(markup).toContain('"Extract"')
    expect(markup).toContain('"Delete"')
  })
})

// What a staff member actually SEES. The lifecycle states are unit-tested as a
// pure function, but nothing rendered the card until a malformed response was
// found producing an empty "Signing packet" shell that every existing assertion
// happily ignored.
describe("DocumentsTab signing packet card", () => {
  let renderer!: ReactTestRenderer

  beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })
  afterEach(async () => {
    await act(async () => renderer.unmount())
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  async function render(packets: unknown[]) {
    stubFetch([baseDocument], packets)
    await act(async () => {
      renderer = create(<DocumentsTab clientId="client-1" popiaConsentGiven />)
    })
    return rendered(renderer)
  }

  it("shows the headline and detail the server computed", async () => {
    const markup = await render([packet()])
    expect(markup).toContain("Signing packet — awaiting signature")
    expect(markup).toContain("APP-0001")
  })

  // Awaiting signature serves the LIVE endpoint, which hardcodes
  // Content-Disposition: inline — so a Download button there would open the
  // same tab as View and promise something it cannot do.
  it("offers View but not Download for the live packet", async () => {
    const markup = await render([packet()])
    expect(markup).toContain('"View"')
    expect(markup).not.toContain('"Download"')
  })

  it("offers both View and Download for a stored document", async () => {
    const markup = await render([packet({
      state: "signed_awaiting_countersignature",
      documentId: "doc-returned",
      downloadUrl: "/api/documents/doc-returned/view",
      headline: "Signed by the consumer — awaiting credit provider countersignature",
    })])
    expect(markup).toContain('"View"')
    expect(markup).toContain('"Download"')
  })

  it("paints a superseded packet as a warning", async () => {
    const markup = await render([packet({
      state: "returned_pending_recording",
      documentId: "doc-r",
      downloadUrl: "/api/documents/doc-r/view",
      headline: "Returned packet uploaded — signature not yet recorded",
      supersededReturnedPacket: true,
    })])
    expect(markup).toContain("bg-red-50")
  })

  it("paints a bound-but-unrecorded packet as a warning", async () => {
    const markup = await render([packet({
      state: "signed_awaiting_countersignature",
      headline: "Signed by the consumer — awaiting credit provider countersignature",
      unrecordedReturnedPacket: true,
    })])
    expect(markup).toContain("bg-red-50")
  })

  // Executed must win the tone chain outright: a red banner over a completed
  // agreement contradicts its own headline.
  it("paints an executed agreement green even if a packet was superseded", async () => {
    const markup = await render([packet({
      state: "executed",
      documentId: "doc-exec",
      downloadUrl: "/api/documents/doc-exec/view",
      headline: "Signed agreement — executed",
      supersededReturnedPacket: true,
    })])
    expect(markup).toContain("bg-green-50")
    expect(markup).not.toContain("bg-red-50")
  })

  it("renders one card per application, since a client can hold two", async () => {
    const markup = await render([
      packet(),
      packet({ applicationId: "app-2", reference: "APP-0002" }),
    ])
    expect(markup).toContain("APP-0001")
    expect(markup).toContain("APP-0002")
  })

  // The defect this describe block was written for: any JSON array reached the
  // card and every field it reads came back undefined.
  it("renders NO card when the response is not lifecycle-shaped", async () => {
    const markup = await render([baseDocument])
    expect(markup).not.toContain("Signing packet\"]")
    expect(markup).not.toContain("Application ")
  })

  it("renders no card when the packet list is empty", async () => {
    const markup = await render([])
    expect(markup).not.toContain("Signing packet\"]")
  })
})
