import { describe, expect, it } from "vitest"
import { countIncrementalUpdates, parsePdfInfo } from "./pdf-tools"

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

describe("countIncrementalUpdates", () => {
  it("counts saves after the first, and allows a linearized file its second %%EOF", () => {
    expect(countIncrementalUpdates(Buffer.from("%PDF-1.7\n...%%EOF\n"))).toBe(0)
    expect(countIncrementalUpdates(Buffer.from("%PDF-1.7\n...%%EOF\n...%%EOF\n"))).toBe(1)
    expect(countIncrementalUpdates(Buffer.from("%PDF-1.7\n%\xe2\xe3\n1 0 obj\n<< /Linearized 1 /L 300 >>\nendobj\n...%%EOF\n...%%EOF\n"))).toBe(0)
  })

  it("counts an appended revision that omits its %%EOF by its startxref", () => {
    expect(countIncrementalUpdates(Buffer.from("%PDF-1.7\n...startxref\n9\n%%EOF\n...xref\ntrailer\nstartxref\n99\n"))).toBe(1)
  })

  it("does not take the word Linearized in a comment for a linearized file", () => {
    expect(countIncrementalUpdates(Buffer.from("%PDF-1.7\n% /Linearized\n1 0 obj\n<< /Type /Catalog >>\n...%%EOF\n...%%EOF\n"))).toBe(1)
  })

  describe("an appended save that adds no object and no xref entry", () => {
    const original = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\nxref\n0 2\n0000000000 65535 f\r\n0000000009 00000 n\r\ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n52\n%%EOF"
    const trailer = "trailer\r\n<</Size 2/Root 1 0 R/Info 9 0 R/ID[<0A1B><0A1B>] /Prev 52/XRefStm 40>>\r\nstartxref\r\n120\r\n%%EOF"
    const appended = (section: string) => countIncrementalUpdates(Buffer.from(original + section, "latin1"))

    it("is not counted: Word's hybrid-xref save writes one, and it cannot change what the file shows", () => {
      expect(appended(`\r\nxref\r\n0 0\r\n${trailer}`)).toBe(0)
      expect(appended(`\nxref\n0 1\n0000000000 65535 f \n${trailer}\n`)).toBe(0)
      expect(appended(`\r\nxref\r\n0 0\r\n${trailer}\r\nxref\r\n0 0\r\n${trailer}`)).toBe(0)
    })

    it("is not counted on a linearized file either", () => {
      const linearized = "%PDF-1.7\n%\xe2\xe3\n1 0 obj\n<< /Linearized 1 /L 300 >>\nendobj\n...%%EOF\n...%%EOF"
      expect(countIncrementalUpdates(Buffer.from(`${linearized}\r\nxref\r\n0 0\r\n${trailer}`, "latin1"))).toBe(0)
    })

    it("counts one that defines an object", () => {
      expect(appended(`\n2 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\nxref\n0 0\n${trailer}`)).toBe(1)
      // A comment is whitespace to a PDF reader: the object header still counts.
      expect(appended(`\n2 0 %x\nobj\n(forged)\nendobj\nxref\n0 0\n${trailer}`)).toBe(1)
    })

    it("counts an xref entry that re-points an object, even with no object in the section", () => {
      expect(appended(`\nxref\n0 1\n0000000000 65535 f \n1 1\n0000000030 00000 n \n${trailer}`)).toBe(1)
    })

    it("counts an xref entry that frees an object: deleting one changes the file too", () => {
      expect(appended(`\nxref\n1 1\n0000000000 00001 f \n${trailer}`)).toBe(1)
    })

    it("counts an object hidden in the trailer for a rebuilt xref to find", () => {
      expect(appended(`\nxref\n0 0\ntrailer\n<</Size 2\n1 0 obj\n/Root 1 0 R>>\nstartxref\n120\n%%EOF`)).toBe(1)
      expect(appended(`\nxref\n0 0\ntrailer\n<</Size 2/Root 1 0 R/Info<</Producer(x)>>>>\nstartxref\n120\n%%EOF`)).toBe(1)
    })

    it("still counts an inert-looking section that omits its %%EOF", () => {
      expect(appended(`\r\nxref\r\n0 0\r\n${trailer.replace("%%EOF", "")}`)).toBe(1)
    })
  })
})
