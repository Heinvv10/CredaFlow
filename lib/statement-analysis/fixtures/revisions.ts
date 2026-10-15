/**
 * Synthetic PDFs for the appended-save tests (pdf-revisions.test.ts): one page
 * showing GENUINE, with SHADOW content hidden in the same bytes for a forged
 * save to reach. Built by hand so each offset, table and trailer is exact.
 */
import { deflateSync } from "zlib"

export const ID = "/ID[<0A1B><0A1B>]"

const stream = (text: string) => `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
export const page = (parent: number, contents: number) =>
  `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 5 0 R >> >> /Contents ${contents} 0 R >>`

/** An xref stream entry: type, then field 2 (offset / object stream) and field 3 (generation / index). */
export type XrefStreamEntry = [number, number, number]

export interface OriginalOptions {
  info?: boolean
  id?: boolean
  /** /Type /XRef streams (as Word's hybrid files carry one), each Word-shaped: W [1 4 2], FlateDecode. */
  xrefStreams?: number
  /** A second, unlisted `4 0 obj` showing SHADOW. */
  shadowFour?: boolean
  /** Entries the xref streams give instead of the classic table's; "shadowFour" and "objStm" stand for those objects. */
  streamOverrides?: Record<number, [number, number | "shadowFour" | "objStm", number]>
  /** Objects packed into one object stream, numbered after the others; the table marks it free, as Word's does. */
  objStm?: Record<number, string>
  /** Objects the classic table marks free though the body still defines them. */
  freed?: number[]
  /** Replaces the xref streams' /W, /Index and decoded data outright (a hostile stream). */
  streamBody?: { w: string; index: string; raw: Buffer }
  padding?: number
}

export interface Original {
  pdf: string
  /** The trailer dictionary's body. */
  trailer: string
  /** Offsets of the xref stream objects. */
  xrefStreams: number[]
  /** The object stream's object number, when there is one. */
  objStm?: number
}

/**
 * Objects 1–5 show GENUINE; 6–9 are an unreferenced second catalog showing
 * SHADOW; 10 is Info. Each xref stream agrees with the classic table, as
 * Word's do, and adds type-2 entries for three objects the table lacks.
 */
export function original(opts: OriginalOptions = {}): Original {
  const { info = true, id = true, xrefStreams = 0, shadowFour = false, streamOverrides = {}, streamBody, objStm, freed = [], padding = 0 } = opts
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page(2, 4),
    stream("BT /F1 18 Tf 20 50 Td (GENUINE) Tj ET"), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Catalog /Pages 7 0 R >>", "<< /Type /Pages /Kids [8 0 R] /Count 1 >>", page(7, 9),
    stream("BT /F1 18 Tf 20 50 Td (SHADOW) Tj ET"),
    ...(info ? ["<< /Producer (T TESTER) >>"] : []),
  ]
  const objStmNumber = objStm ? objects.length + 1 : undefined
  if (objStm) {
    const packed = Object.entries(objStm)
    let [header, body] = ["", ""]
    for (const [num, o] of packed) {
      header += `${num} ${body.length} `
      body += `${o}\n`
    }
    objects.push(`<< /Type /ObjStm /N ${packed.length} /First ${header.length} /Length ${header.length + body.length} >>\nstream\n${header}${body}\nendstream`)
  }
  let pdf = `%PDF-1.7\n${padding ? `%${"x".repeat(padding)}\n` : ""}`
  const offsets = objects.map((o, n) => {
    const at = pdf.length
    pdf += `${n + 1} 0 obj\n${o}\nendobj\n`
    return at
  })
  const shadowAt = pdf.length
  if (shadowFour) pdf += `4 0 obj\n${stream("BT /F1 18 Tf 20 50 Td (SHADOW) Tj ET")}\nendobj\n`
  const size = objects.length + 1 + xrefStreams
  const streams: number[] = []
  for (let s = 0; s < xrefStreams; s++) {
    streams.push(pdf.length)
    offsets.push(pdf.length)
    const entries: XrefStreamEntry[] = [[0, 0, 65535], ...offsets.map((o): XrefStreamEntry => [1, o, 0])]
    while (entries.length < size) entries.push([1, offsets[offsets.length - 1], 0])
    for (let j = 0; j < 3; j++) entries.push([2, 9999, j])
    for (const [num, [type, f2, f3]] of Object.entries(streamOverrides)) entries[Number(num)] = [type, f2 === "shadowFour" ? shadowAt : f2 === "objStm" ? objStmNumber ?? 0 : f2, f3]
    const raw = streamBody?.raw ?? Buffer.concat(entries.map(([t, f2, f3]) => {
      const e = Buffer.alloc(7)
      e.writeUInt8(t, 0)
      e.writeUInt32BE(f2, 1)
      e.writeUInt16BE(f3, 5)
      return e
    }))
    const data = deflateSync(raw).toString("latin1")
    pdf += `${objects.length + 1 + s} 0 obj\n<</Type/XRef/Size ${entries.length}${streamBody ? `/W${streamBody.w}/Index${streamBody.index}` : "/W[1 4 2]"}/Root 1 0 R/Filter/FlateDecode/Length ${data.length}>>stream\r\n${data}\r\nendstream\nendobj\n`
  }
  const trailer = `/Size ${size}/Root 1 0 R${info ? "/Info 10 0 R" : ""}${id ? ID : ""}`
  const xref = pdf.length
  pdf += `xref\n0 ${size}\n0000000000 65535 f \n${offsets.map((o, n) =>
    freed.includes(n + 1) || n + 1 === objStmNumber ? "0000000000 00001 f \n" : `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
  return { pdf: `${pdf}trailer\n<<${trailer}>>\nstartxref\n${xref}\n%%EOF`, trailer, xrefStreams: streams, objStm: objStmNumber }
}

export const lastStartxref = (pdf: string) => Number(/startxref\s+(\d+)\s+%%EOF$/.exec(pdf)![1])

/** Appends a save shaped like Word's; `dict` is its trailer dictionary's body. */
export function save(pdf: string, dict: string, opts: { before?: string; xref?: string; startxref?: number } = {}): string {
  const { before = "\r\n", xref = "0 0\r\n", startxref = pdf.length + before.length } = opts
  return `${pdf}${before}xref\r\n${xref}trailer\r\n<<${dict}>>\r\nstartxref\r\n${startxref}\r\n%%EOF`
}

/** Word's own: the previous trailer repeated, /Prev at the previous xref. */
export const wordSave = (pdf: string, trailer: string, extra = "") => save(pdf, `${trailer} /Prev ${lastStartxref(pdf)}${extra}`)
