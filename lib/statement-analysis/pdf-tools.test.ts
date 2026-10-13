import { describe, expect, it } from "vitest"
import { countIncrementalUpdates, parsePdfInfo } from "./pdf-tools"

describe("parsePdfInfo", () => {
  it("reads an empty field as null instead of taking the next line's value", () => {
    const info = parsePdfInfo("Creator:\nProducer:        OpenPDF 2.0.2\nCreationDate:    2026-10-01T08:00:00Z\nPages:           3\n")
    expect(info).toEqual({ producer: "OpenPDF 2.0.2", creator: null, createdAt: "2026-10-01T08:00:00Z", modifiedAt: null, pages: 3 })
  })
})

describe("countIncrementalUpdates", () => {
  it("counts saves after the first, and allows a linearized file its second %%EOF", () => {
    expect(countIncrementalUpdates(Buffer.from("%PDF-1.7\n...%%EOF\n"))).toBe(0)
    expect(countIncrementalUpdates(Buffer.from("%PDF-1.7\n...%%EOF\n...%%EOF\n"))).toBe(1)
    expect(countIncrementalUpdates(Buffer.from("%PDF-1.7\n<</Linearized 1>>...%%EOF\n...%%EOF\n"))).toBe(0)
  })
})
