import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DocumentPreviewBody } from "./DocumentPreviewDialog"
import type { DocumentRecord } from "@/lib/document-types"

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

const DOC = {
  id: "doc-1",
  docType: "CREDIT_AGREEMENT",
  fileName: "credit-agreement-app-1.pdf",
  mimeType: "application/pdf",
} as unknown as DocumentRecord

function rendered(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON())
}

describe("DocumentPreviewBody", () => {
  let renderer!: ReactTestRenderer
  const originalFetch = globalThis.fetch
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    URL.createObjectURL = vi.fn(() => "blob:preview-1")
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("renders the server's refusal as a readable message, not raw JSON in the pane", async () => {
    // Regression: the pane was an <iframe src="/api/documents/x/view"> which
    // painted {"error":...,"agreementIntegrity":"binding_missing"} as the
    // document body — staff read it as a corrupted PDF.
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({
        error: "The credit agreement is missing its document integrity binding and cannot be viewed.",
        agreementIntegrity: "binding_missing",
      }),
      { status: 422, headers: { "content-type": "application/json" } },
    )) as typeof fetch

    await act(async () => {
      renderer = create(<DocumentPreviewBody doc={DOC} open />)
    })

    const markup = rendered(renderer)
    expect(markup).toContain("Document cannot be displayed")
    expect(markup).toContain("missing its document integrity binding")
    expect(markup).not.toContain("agreementIntegrity")
    expect(renderer.root.findAllByType("iframe")).toHaveLength(0)
  })

  it("streams served bytes into the viewer via an object URL", async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      new Blob([Buffer.from("%PDF-1.4 test")]),
      { status: 200, headers: { "content-type": "application/pdf" } },
    )) as typeof fetch

    await act(async () => {
      renderer = create(<DocumentPreviewBody doc={DOC} open />)
    })

    const iframe = renderer.root.findByType("iframe")
    expect(iframe.props.src).toBe("blob:preview-1")
  })
})
