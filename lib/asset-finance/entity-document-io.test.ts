import { describe, expect, it } from "vitest"
import { entityDocumentDisposition } from "./content-disposition"

describe("entityDocumentDisposition", () => {
  it("serves Unicode names through an ASCII fallback and an encoded filename", () => {
    const value = entityDocumentDisposition("attachment", "AFS – 2026.pdf", (name) => name)

    expect(() => new Response(null, { headers: { "Content-Disposition": value } })).not.toThrow()
    expect(value).toContain('filename="AFS _ 2026.pdf"')
    expect(value).toContain("filename*=UTF-8''AFS%20%E2%80%93%202026.pdf")
  })
})
