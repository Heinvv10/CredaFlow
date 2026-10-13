/**
 * Doctored variants of a synthetic statement, each the way a real edit is
 * made, for the tamper tests (goal §8.2):
 *
 *   incrementalAmountEdit  — one printed amount changed by an appended
 *                            incremental update, as a PDF editor saves it
 *   resaveWithProducer     — the whole file re-saved by another program
 *   (misprint)             — built by synthetic.ts: an amount changed without
 *                            fixing the balances
 *   modifiedAfterCreation  — built by synthetic.ts with a later ModDate
 */
import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef } from "pdf-lib"

/** Replaces the first `from` inside a shown <hex> string; null when none shows it. */
function editShownText(content: string, from: string, to: string): string | null {
  let done = false
  const out = content.replace(/<([0-9A-Fa-f]+)>/g, (whole, hex: string) => {
    const shown = Buffer.from(hex, "hex").toString("latin1")
    if (done || !shown.includes(from)) return whole
    done = true
    return `<${Buffer.from(shown.replace(from, to), "latin1").toString("hex").toUpperCase()}>`
  })
  return done ? out : null
}

function contentRefs(doc: PDFDocument): PDFRef[] {
  const refs: PDFRef[] = []
  for (const page of doc.getPages()) {
    const contents = page.node.get(PDFName.of("Contents"))
    if (contents instanceof PDFRef) refs.push(contents)
    else if (contents instanceof PDFArray) contents.asArray().forEach((r) => r instanceof PDFRef && refs.push(r))
  }
  return refs
}

/**
 * Appends an incremental update that redefines the content stream showing
 * `from` so it shows `to` instead (same length, so the layout holds). The
 * original bytes are untouched: the edit lives after the first %%EOF.
 */
export async function incrementalAmountEdit(original: Uint8Array, from: string, to: string): Promise<Uint8Array> {
  if (from.length !== to.length) throw new Error("replacement must keep the text length")
  const doc = await PDFDocument.load(original)
  for (const ref of contentRefs(doc)) {
    const stream = doc.context.lookup(ref)
    if (!(stream instanceof PDFRawStream)) continue
    const text = editShownText(Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1"), from, to)
    if (text === null) continue
    const edited = Buffer.from(text, "latin1")

    const base = Buffer.from(original)
    const tail = base.subarray(base.lastIndexOf("trailer")).toString("latin1")
    const prevXref = Number(/startxref\s+(\d+)/.exec(tail)![1])
    const size = Number(/\/Size (\d+)/.exec(tail)![1])
    const root = /\/Root (\d+ \d+ R)/.exec(tail)![1]
    const info = /\/Info (\d+ \d+ R)/.exec(tail)?.[1]

    const objOffset = base.length + 1
    const obj = Buffer.concat([
      Buffer.from(`\n${ref.objectNumber} ${ref.generationNumber} obj\n<< /Length ${edited.length} >>\nstream\n`, "latin1"),
      edited,
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    ])
    const xrefOffset = base.length + obj.length
    const xref = `xref\n0 1\n0000000000 65535 f \n${ref.objectNumber} 1\n${String(objOffset).padStart(10, "0")} ${String(ref.generationNumber).padStart(5, "0")} n \n` +
      `trailer\n<< /Size ${size} /Root ${root}${info ? ` /Info ${info}` : ""} /Prev ${prevXref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    return Buffer.concat([base, obj, Buffer.from(xref, "latin1")])
  }
  throw new Error(`no content stream shows ${from}`)
}

/** Loads and re-saves the whole file under another program's name. */
export async function resaveWithProducer(original: Uint8Array, producer: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { updateMetadata: false })
  doc.setProducer(producer)
  doc.setCreator(producer)
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false })
}
