import { describe, expect, it } from "vitest"
import { countIncrementalUpdates, parsePdfInfo, readPdf } from "./pdf-tools"

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
    const ID = "/ID[<0A1B><0A1B>]"
    const stream = (text: string) => `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
    /**
     * A one-page PDF showing GENUINE whose bytes also hold an unreferenced second
     * catalog (objects 6–9) showing SHADOW; then optionally an Info dictionary and
     * a /Type /XRef stream, as Word's hybrid files carry; /ID optional.
     */
    function original({ info = true, id = true, xrefStreams = 0, padding = 0 } = {}): { pdf: string; trailer: string } {
      const page = (parent: number, contents: number) =>
        `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 5 0 R >> >> /Contents ${contents} 0 R >>`
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page(2, 4),
        stream("BT /F1 18 Tf 20 50 Td (GENUINE) Tj ET"), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Type /Catalog /Pages 7 0 R >>", "<< /Type /Pages /Kids [8 0 R] /Count 1 >>", page(7, 9),
        stream("BT /F1 18 Tf 20 50 Td (SHADOW) Tj ET"),
        ...(info ? ["<< /Producer (T TESTER) >>"] : []),
        ...Array.from({ length: xrefStreams }, () => "<< /Type /XRef /Size 1 /W [1 1 1] /Index [0 0] /Length 0 >>\nstream\n\nendstream"),
      ]
      let pdf = `%PDF-1.7\n${padding ? `%${"x".repeat(padding)}\n` : ""}`
      const offsets = objects.map((o, n) => {
        const at = pdf.length
        pdf += `${n + 1} 0 obj\n${o}\nendobj\n`
        return at
      })
      const size = objects.length + 1
      const trailer = `/Size ${size}/Root 1 0 R${info ? "/Info 10 0 R" : ""}${id ? ID : ""}`
      const xref = pdf.length
      pdf += `xref\n0 ${size}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
      return { pdf: `${pdf}trailer\n<<${trailer}>>\nstartxref\n${xref}\n%%EOF`, trailer }
    }
    const lastStartxref = (pdf: string) => Number(/startxref\s+(\d+)\s+%%EOF$/.exec(pdf)![1])
    /** Appends a save shaped like Word's; `dict` is its trailer dictionary's body. */
    function save(pdf: string, dict: string, opts: { before?: string; xref?: string; startxref?: number } = {}): string {
      const { before = "\r\n", xref = "0 0\r\n", startxref = pdf.length + before.length } = opts
      return `${pdf}${before}xref\r\n${xref}trailer\r\n<<${dict}>>\r\nstartxref\r\n${startxref}\r\n%%EOF`
    }
    /** Word's own: the previous trailer repeated, /Prev at the previous xref. */
    const wordSave = (pdf: string, trailer: string, extra = "") => save(pdf, `${trailer} /Prev ${lastStartxref(pdf)}${extra}`)
    const count = (pdf: string) => countIncrementalUpdates(Buffer.from(pdf, "latin1"))
    const { pdf, trailer } = original()

    it("is not counted: Word's hybrid-xref save writes one, and it cannot change what the file shows", () => {
      expect(count(wordSave(pdf, trailer))).toBe(0)
      expect(count(save(pdf, `${trailer} /Prev ${lastStartxref(pdf)}`, { before: "\n", xref: "0 1\n0000000000 65535 f \n" }))).toBe(0)
      expect(count(wordSave(wordSave(pdf, trailer), trailer))).toBe(0)
    })

    it("is not counted when its /XRefStm names the original's one xref stream, as Word's does", async () => {
      const hybrid = original({ xrefStreams: 1 })
      const xrefStm = hybrid.pdf.indexOf("11 0 obj")
      expect(count(wordSave(hybrid.pdf, hybrid.trailer, `/XRefStm ${xrefStm}`))).toBe(0)
      const twice = wordSave(hybrid.pdf, hybrid.trailer, `/XRefStm ${xrefStm}`)
      expect(count(wordSave(twice, hybrid.trailer, `/XRefStm ${xrefStm}`))).toBe(0)
    })

    it("is not counted on a linearized file either", () => {
      const head = "%PDF-1.7\n%\xe2\xe3\n1 0 obj\n<< /Linearized 1 /L 300 >>\nendobj\ntrailer\n<</Size 2>>\nstartxref\n0\n%%EOF\n2 0 obj\n<< >>\nendobj\n"
      const linearized = `${head}xref\n0 1\n0000000000 65535 f \ntrailer\n<<${trailer}>>\nstartxref\n${head.length}\n%%EOF`
      expect(count(wordSave(linearized, trailer))).toBe(0)
    })

    it("counts one that points /Root at a catalog the original never referenced, which swaps the content", async () => {
      // The breaker's repro: everything else repeated, /Root moved to the shadow catalog.
      const base = original({ info: false, id: false })
      const swapped = save(base.pdf, `/Size 10/Root 6 0 R/Prev ${lastStartxref(base.pdf)}`)
      expect((await readPdf(Buffer.from(base.pdf, "latin1"))).pages.join("")).toContain("GENUINE")
      expect((await readPdf(Buffer.from(swapped, "latin1"))).pages.join("")).toContain("SHADOW")
      expect(count(swapped)).toBeGreaterThanOrEqual(1)
    })

    it("counts one whose trailer differs from the previous save's", () => {
      const prev = lastStartxref(pdf)
      expect(count(save(pdf, `/Size 6/Root 1 0 R/Info 10 0 R${ID} /Prev ${prev}`)), "shrunk /Size").toBe(1)
      expect(count(save(pdf, `/Size 11/Root 1 0 R/Info 5 0 R${ID} /Prev ${prev}`)), "changed /Info").toBe(1)
      expect(count(save(pdf, `/Size 11/Root 1 0 R/Info 10 0 R${ID} /Prev ${prev}`.replace("<0A1B>]", "<0A1C>]"))), "changed /ID").toBe(1)
      expect(count(wordSave(pdf, trailer, "/Encrypt 5 0 R")), "added /Encrypt").toBe(1)
      expect(count(wordSave(pdf, trailer, "/Extra 5 0 R")), "a key Word does not write").toBe(1)
    })

    it("counts one whose /Prev or own startxref is not where the xref is", () => {
      expect(count(save(pdf, `${trailer} /Prev ${lastStartxref(pdf) - 1}`)), "/Prev").toBe(1)
      expect(count(save(pdf, `${trailer} /Prev ${lastStartxref(pdf)}`, { startxref: lastStartxref(pdf) })), "startxref").toBe(1)
    })

    it("counts one whose /XRefStm is not the original's one xref stream", () => {
      const one = original({ xrefStreams: 1 })
      expect(count(wordSave(one.pdf, one.trailer, `/XRefStm ${one.pdf.indexOf("4 0 obj")}`)), "a content stream").toBe(1)
      const two = original({ xrefStreams: 2 })
      expect(count(wordSave(two.pdf, two.trailer, `/XRefStm ${two.pdf.indexOf("11 0 obj")}`)), "one of two").toBe(1)
    })

    it("counts one after an original with no classic trailer to compare against", () => {
      const streamOnly = "%PDF-1.7\n1 0 obj\n<< /Type /XRef /Size 2 /Root 1 0 R /W [1 1 1] /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\n9\n%%EOF"
      expect(count(save(streamOnly, "/Size 2/Root 1 0 R /Prev 9"))).toBe(1)
    })

    it("counts one that defines an object", () => {
      const obj = "\n12 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n"
      expect(count(save(pdf, `${trailer} /Prev ${lastStartxref(pdf)}`, { before: obj }))).toBe(1)
      // A comment is whitespace to a PDF reader: the object header still counts.
      expect(count(save(pdf, `${trailer} /Prev ${lastStartxref(pdf)}`, { before: "\n12 0 %x\nobj\n(forged)\nendobj\n" }))).toBe(1)
    })

    it("counts an xref entry that re-points or frees an object, even with no object in the section", () => {
      const dict = `${trailer} /Prev ${lastStartxref(pdf)}`
      expect(count(save(pdf, dict, { xref: "0 1\n0000000000 65535 f \n1 1\n0000000030 00000 n \n" })), "re-point").toBe(1)
      expect(count(save(pdf, dict, { xref: "1 1\n0000000000 00001 f \n" })), "free").toBe(1)
    })

    it("counts an object hidden in the trailer for a rebuilt xref to find", () => {
      expect(count(save(pdf, `${trailer}\n6 0 obj\n /Prev ${lastStartxref(pdf)}`))).toBe(1)
      expect(count(wordSave(pdf, trailer, "/Extra<</Producer(x)>>"))).toBe(1)
    })

    it("stays linear in the file size on 50,000 %%EOF sections with no trailer to find", () => {
      const pdf = `%PDF-1.7\n${"% a section of filler\n%%EOF".repeat(50_000)}`
      const t = performance.now()
      expect(countIncrementalUpdates(Buffer.from(pdf, "latin1"))).toBe(49_999)
      expect(performance.now() - t).toBeLessThan(500)
    })

    it("reads the original once however many saves alternate their /XRefStm", () => {
      const big = original({ xrefStreams: 1, padding: 4_000_000 })
      const [stream, content] = [big.pdf.indexOf("\n11 0 obj") + 1, big.pdf.indexOf("\n4 0 obj") + 1]
      let [pdf, prev] = [big.pdf, lastStartxref(big.pdf)]
      // Every other save names a content stream (counted); each one after it names the xref stream again.
      for (let i = 0; i < 2_000; i++) {
        const next = pdf.length + 2
        pdf = save(pdf, `${big.trailer} /Prev ${prev}/XRefStm ${i % 2 ? stream : content}`)
        prev = next
      }
      const t = performance.now()
      expect(count(pdf)).toBe(1_000)
      expect(performance.now() - t).toBeLessThan(500)
    })

    it("still counts one that omits its %%EOF", () => {
      expect(count(wordSave(pdf, trailer).replace(/%%EOF$/, ""))).toBe(1)
    })
  })
})
