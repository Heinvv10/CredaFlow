import { inflateSync } from "node:zlib"

/** One text run drawn via `Tm` + `Tj` in a PDF content stream. */
export interface PdfTextRun {
  x: number
  y: number
  text: string
}

/**
 * Extracts every text run pdf-lib drew (position + decoded string) across
 * all pages/content streams in a generated PDF buffer. Lets tests assert on
 * WHERE text was placed, not just that a substring exists somewhere in the
 * document — needed to catch header lines silently overlapping when a
 * fallback layout path (e.g. missing logo asset) reuses the wrong coordinates.
 */
export function extractPdfTextRuns(buf: Buffer): PdfTextRun[] {
  const runs: PdfTextRun[] = []
  const s = buf.toString("latin1")
  let i = 0
  while (i < s.length) {
    const start = s.indexOf("stream", i)
    if (start === -1) break
    let bodyStart = start + 6
    while (s[bodyStart] === "\r" || s[bodyStart] === "\n") bodyStart++
    const end = s.indexOf("endstream", bodyStart)
    if (end === -1) break
    const raw = buf.subarray(bodyStart, end)
    i = end + 9
    let inflated: string
    try {
      inflated = inflateSync(raw).toString("latin1")
    } catch {
      continue
    }
    const re = /1 0 0 (?:-)?1 ([\d.\-]+) ([\d.\-]+) Tm\s*<([0-9A-Fa-f]+)> Tj/g
    let m: RegExpExecArray | null
    while ((m = re.exec(inflated)) !== null) {
      const hex = m[3]
      let text = ""
      for (let j = 0; j < hex.length; j += 2) text += String.fromCharCode(parseInt(hex.slice(j, j + 2), 16))
      runs.push({ x: parseFloat(m[1]), y: parseFloat(m[2]), text })
    }
  }
  return runs
}
