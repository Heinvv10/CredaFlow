import { describe, expect, it } from "vitest"
import { ID, lastStartxref, original, save, wordSave } from "./fixtures/revisions"
import { countIncrementalUpdates } from "./pdf-revisions"
import { readPdf } from "./pdf-tools"

const count = (pdf: string) => countIncrementalUpdates(Buffer.from(pdf, "latin1"))
const shows = async (pdf: string) => (await readPdf(Buffer.from(pdf, "latin1"))).pages.join("")

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
})

describe("an appended save that adds no object and no xref entry", () => {
  const { pdf, trailer } = original()

  it("is not counted: Word's hybrid-xref save writes one, and it cannot change what the file shows", () => {
    expect(count(wordSave(pdf, trailer))).toBe(0)
    expect(count(save(pdf, `${trailer} /Prev ${lastStartxref(pdf)}`, { before: "\n", xref: "0 1\n0000000000 65535 f \n" }))).toBe(0)
    expect(count(wordSave(wordSave(pdf, trailer), trailer))).toBe(0)
  })

  it("is not counted when its /XRefStm names the original's xref stream and that agrees with the table, as Word's does", async () => {
    const hybrid = original({ xrefStreams: 1 })
    const once = wordSave(hybrid.pdf, hybrid.trailer, `/XRefStm ${hybrid.xrefStreams[0]}`)
    expect(await shows(once)).toContain("GENUINE")
    expect(count(once)).toBe(0)
    expect(count(wordSave(once, hybrid.trailer, `/XRefStm ${hybrid.xrefStreams[0]}`))).toBe(0)
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
    expect(await shows(base.pdf)).toContain("GENUINE")
    expect(await shows(swapped)).toContain("SHADOW")
    expect(count(swapped)).toBeGreaterThanOrEqual(1)
  })

  it("counts one that repeats a decoy trailer rather than the one a reader takes after the xref", async () => {
    // The tester's repro: the real trailer follows the xref; a second, later one names the shadow catalog.
    const base = original({ info: false, id: false })
    const decoyed = base.pdf.replace("trailer\n<</Size 10/Root 1 0 R>>", "trailer\n<</Size 10/Root 1 0 R>>\ntrailer\n<</Size 10/Root 6 0 R>>")
    const swapped = save(decoyed, `/Size 10/Root 6 0 R/Prev ${lastStartxref(decoyed)}`)
    expect(await shows(decoyed)).toContain("GENUINE")
    expect(await shows(swapped)).toContain("SHADOW")
    expect(count(swapped)).toBeGreaterThanOrEqual(1)
  })

  it("counts one whose /Prev names an xref stream, which a decoy classic trailer after it does not describe", async () => {
    const o = original({ info: false, id: false, xrefStreams: 1 })
    const at = o.xrefStreams[0]
    const decoyed = `${o.pdf.slice(0, o.pdf.lastIndexOf("xref\n0 "))}trailer\n<</Size 11/Root 6 0 R>>\nstartxref\n${at}\n%%EOF`
    const swapped = save(decoyed, `/Size 11/Root 6 0 R/Prev ${at}`)
    expect(await shows(decoyed)).toContain("GENUINE")
    expect(await shows(swapped)).toContain("SHADOW")
    expect(count(swapped)).toBeGreaterThanOrEqual(1)
  })

  it("counts an /XRefStm added after an original whose own trailer chains to an earlier table", () => {
    const o = original({ xrefStreams: 1 })
    const chained = `${o.trailer}/Prev ${lastStartxref(o.pdf)}`
    const pdf = o.pdf.replace(`<<${o.trailer}>>`, `<<${chained}>>`)
    expect(count(wordSave(pdf, o.trailer, `/XRefStm ${o.xrefStreams[0]}`))).toBe(1)
  })

  it("counts one whose /XRefStm stream maps an object in use to somewhere else, which swaps the content", async () => {
    // The tester's repro: the table lists object 4 as GENUINE; the xref stream maps it to a second "4 0 obj".
    const base = original({ xrefStreams: 1, shadowFour: true, streamOverrides: { 4: [1, "shadowFour", 0] } })
    const swapped = wordSave(base.pdf, base.trailer, `/XRefStm ${base.xrefStreams[0]}`)
    expect(await shows(base.pdf)).toContain("GENUINE")
    expect(await shows(swapped)).toContain("SHADOW")
    expect(count(swapped)).toBeGreaterThanOrEqual(1)
  })

  it("counts one whose /XRefStm stream frees, compresses or re-generations an object the table has in use", () => {
    const four = pdf.indexOf("\n4 0 obj") + 1
    const entries: Array<[string, [number, number, number]]> = [["free", [0, four, 0]], ["compressed", [2, four, 0]], ["generation", [1, four, 1]]]
    for (const [label, entry] of entries) {
      const o = original({ xrefStreams: 1, streamOverrides: { 4: entry } })
      expect(count(wordSave(o.pdf, o.trailer, `/XRefStm ${o.xrefStreams[0]}`)), label).toBe(1)
    }
  })

  it("counts one whose /XRefStm stream cannot be decoded exactly", () => {
    const o = original({ xrefStreams: 1 })
    const at = o.xrefStreams[0]
    const corrupt = (from: string, to: string) => o.pdf.slice(0, at) + o.pdf.slice(at).replace(from, to)
    const tail = (p: string) => wordSave(p, o.trailer, `/XRefStm ${at}`)
    expect(count(tail(corrupt("/W[1 4 2]", "/W[1 4 1]"))), "entry width").toBe(1)
    expect(count(tail(corrupt("stream\r\nx", "stream\r\ny"))), "inflate").toBe(1)
    expect(count(tail(corrupt("/Size 15", "/Size 14"))), "entry count").toBe(1)
    // Same length, so every offset after it holds: only the key differs.
    expect(count(tail(corrupt("/Root 1 0 R/Filter", "/Prev 1 0 R/Filter"))), "a key Word does not write").toBe(1)
  })

  it("counts one that adds an /XRefStm after the first save following the original", () => {
    const o = original({ xrefStreams: 1 })
    expect(count(wordSave(wordSave(o.pdf, o.trailer), o.trailer, `/XRefStm ${o.xrefStreams[0]}`))).toBe(1)
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
    expect(count(wordSave(one.pdf, one.trailer, `/XRefStm ${one.pdf.indexOf("\n4 0 obj") + 1}`)), "a content stream").toBe(1)
    const two = original({ xrefStreams: 2 })
    expect(count(wordSave(two.pdf, two.trailer, `/XRefStm ${two.xrefStreams[1]}`)), "one of two").toBe(1)
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

  it("still counts one that omits its %%EOF", () => {
    expect(count(wordSave(pdf, trailer).replace(/%%EOF$/, ""))).toBe(1)
  })
})

describe("the cost of checking appended saves stays linear in the file size", () => {
  const timed = (pdf: string, expected: number) => {
    const bytes = Buffer.from(pdf, "latin1")
    const t = performance.now()
    expect(countIncrementalUpdates(bytes)).toBe(expected)
    expect(performance.now() - t).toBeLessThan(500)
  }

  it("on 50,000 %%EOF sections with no trailer to find", () => {
    timed(`%PDF-1.7\n${"% a section of filler\n%%EOF".repeat(50_000)}`, 49_999)
  })

  it("on 20,000 saves whose /Prev sends the decoy check back to the start of a 1 MB file", () => {
    // Every other save is well formed with /Prev at byte 9, so each one asks for the first trailer after it.
    // Filler of near-misses, so a forward scan for "trailer" cannot skip through it.
    let pdf = `%PDF-1.7\nxref\n%${"traile ".repeat(150_000)}\ntrailer\n<</Size 1>>\nstartxref\n9\n%%EOF`
    for (let i = 0; i < 20_000; i++) pdf = save(pdf, "/Size 1 /Prev 9", i % 2 ? {} : { startxref: 9 })
    timed(pdf, 20_000)
  })

  it("on 2,000 saves alternating their /XRefStm over a 4 MB original", () => {
    const big = original({ xrefStreams: 1, padding: 4_000_000 })
    const content = big.pdf.indexOf("\n4 0 obj") + 1
    let [pdf, prev] = [big.pdf, lastStartxref(big.pdf)]
    for (let i = 0; i < 2_000; i++) {
      const next = pdf.length + 2
      pdf = save(pdf, `${big.trailer} /Prev ${prev}/XRefStm ${i % 2 ? big.xrefStreams[0] : content}`)
      prev = next
    }
    timed(pdf, 2_000)
  })
})
