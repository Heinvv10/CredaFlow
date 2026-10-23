// The wording and the pure NCA renderers must not pull the document loader's
// database, identity and rate graph in just to throw a DealDocumentError: that
// error lives in ./deal-document-error.ts. Loading ./deal-document-data.ts
// here is made to fail.
import { describe, expect, it, vi } from "vitest"

vi.mock("./deal-document-data", () => {
  throw new Error("the loader module was imported")
})

describe("the commission wording is pure", () => {
  it("builds the row and the paragraph, and refuses a bad name, without the loader", async () => {
    const wording = await import("./wording/commission-disclosure")
    const { DealDocumentError } = await import("./deal-document-error")
    expect(wording.introducerRow({ name: "SAMPLE Dealer", kind: "DEALER" })).toEqual(["Introducer", "SAMPLE Dealer (dealer)"])
    expect(wording.commissionDisclosure("NCA_QUOTATION")).toContain("the introducer named above")
    expect(() => wording.introducerRow({ name: "Mo­tors", kind: "DEALER" })).toThrow(DealDocumentError)
  })

  it("the NCA quotation renderer and the shared document parts load without it", async () => {
    await expect(import("./nca/quote-pdf")).resolves.toHaveProperty("renderNcaAssetQuote")
    await expect(import("./document-parts")).resolves.toHaveProperty("introducerSection")
  })

  it("the loader module still exports the same error class", async () => {
    vi.doUnmock("./deal-document-data")
    vi.resetModules()
    const [{ DealDocumentError: fromLoader }, { DealDocumentError: own }] = await Promise.all([import("./deal-document-data"), import("./deal-document-error")])
    expect(fromLoader).toBe(own)
  })
})
