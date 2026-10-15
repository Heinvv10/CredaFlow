import { describe, expect, it } from "vitest"
import { parsePdfInfo } from "./pdf-tools"

describe("parsePdfInfo", () => {
  it("reads an empty field as null instead of taking the next line's value", () => {
    const info = parsePdfInfo("Creator:\nProducer:        OpenPDF 2.0.2\nCreationDate:    2026-10-01T08:00:00Z\nPages:           3\n")
    expect(info).toEqual({ producer: "OpenPDF 2.0.2", creator: null, createdAt: "2026-10-01T08:00:00Z", modifiedAt: null, pages: 3, metadataAmbiguous: false })
  })

  it("trusts no metadata when a field is printed twice: a value forged the lines after it", () => {
    const info = parsePdfInfo("Title:           x\nProducer:        OpenPDF 2.0.2\nCreator:         Word\nProducer:        Microsoft Word\nPages:           1\n")
    // An ambiguous file reads as too long for any reader, so it goes to manual review.
    expect(info).toMatchObject({ producer: null, creator: null, createdAt: null, modifiedAt: null, metadataAmbiguous: true, pages: Number.MAX_SAFE_INTEGER })
  })

  it("distrusts a page count printed twice", () => {
    expect(parsePdfInfo("Title:  x\nPages:  1\nProducer:  OpenPDF 2.0.2\nPages:  40\n")).toMatchObject({ metadataAmbiguous: true, producer: null })
  })
})
