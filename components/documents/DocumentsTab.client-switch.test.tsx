// @vitest-environment jsdom
// The tab is not remounted when the client page moves to another client, so a
// client change must put the spinner up and take the previous client's
// documents down until the new client's list arrives.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DocumentsTab } from "./DocumentsTab"
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const doc = (id: string) => ({ id, clientId: "x", docType: "ID_COPY", fileUrl: "/u/a.pdf", fileName: `${id}.pdf`, verified: false, uploadedByType: "staff", uploadedById: "o", deletedAt: null, fileSize: 1, mimeType: "application/pdf", extractionStatus: "skipped", extractionResult: null, extractionError: null, validationResult: null, validationMismatch: false, validationScore: null, biometricMatchScore: null, biometricLiveness: null, biometricVerifiedAt: null, biometricResult: null, verifiedAt: null, verifiedById: null, verificationNote: null, createdAt: "2026-07-29T08:00:00.000Z" })
afterEach(() => vi.unstubAllGlobals())
describe("DocumentsTab on a client change", () => {
  it("shows the spinner, not the previous client's documents, until the new list arrives", async () => {
    let release!: (v: Response) => void
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("signing-packets")) return Promise.resolve(Response.json([]))
      if (String(url).includes("client-1")) return Promise.resolve(Response.json([doc("c1doc")]))
      return new Promise<Response>((r) => { release = r })
    }))
    let r!: ReactTestRenderer
    await act(async () => { r = create(<DocumentsTab clientId="client-1" popiaConsentGiven />) })
    expect(JSON.stringify(r.toJSON())).toContain("c1doc")
    await act(async () => { r.update(<DocumentsTab clientId="client-2" popiaConsentGiven />) })
    const s = JSON.stringify(r.toJSON())
    expect(s).not.toContain("c1doc")
    expect(s).toContain("Loading documents")
    await act(async () => { release(Response.json([])) })
  })
})
