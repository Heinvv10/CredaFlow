import { describe, expect, it } from "vitest"
import { countIncrementalUpdates, parsePdfInfo } from "./pdf-tools"

describe("parsePdfInfo", () => {
  it("reads an empty field as null instead of taking the next line's value", () => {
    const info = parsePdfInfo("Creator:\nProducer:        OpenPDF 2.0.2\nCreationDate:    2026-10-01T08:00:00Z\nPages:           3\n")
    expect(info).toEqual({ producer: "OpenPDF 2.0.2", creator: null, createdAt: "2026-10-01T08:00:00Z", modifiedAt: null, pages: 3, metadataAmbiguous: false })
  })

  it("trusts no metadata when a field is printed twice: a value forged the lines after it", () => {
    const info = parsePdfInfo("Title:           x\nProducer:        OpenPDF 2.0.2\nCreator:         Word\nProducer:        Microsoft Word\nPages:           1\n")
    expect(info).toMatchObject({ producer: null, creator: null, createdAt: null, modifiedAt: null, metadataAmbiguous: true, pages: 1 })
  })
})

describe("countIncrementalUpdates", () => {
  it("counts saves after the first, and allows a linearized file its second %%EOF", () => {
    expect(countIncrementalUpdates(Buffer.from("%PDF-1.7\n...%%EOF\n"))).toBe(0)
    expect(countIncrementalUpdates(Buffer.from("%PDF-1.7\n...%%EOF\n...%%EOF\n"))).toBe(1)
    expect(countIncrementalUpdates(Buffer.from("%PDF-1.7\n%\xe2\xe3\n1 0 obj\n<< /Linearized 1 /L 300 >>\nendobj\n...%%EOF\n...%%EOF\n"))).toBe(0)
  })

  it("does not take the word Linearized in a comment for a linearized file", () => {
    expect(countIncrementalUpdates(Buffer.from("%PDF-1.7\n% /Linearized\n1 0 obj\n<< /Type /Catalog >>\n...%%EOF\n...%%EOF\n"))).toBe(1)
  })
})
