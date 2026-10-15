/**
 * poppler calls for the statement reader: document facts (pdfinfo) and the
 * text layer (pdftotext -layout, and -bbox for word positions).
 *
 * Same containment as lib/vlm-extract.ts: the bytes go to a 0700 temp dir that
 * is removed on every path, the tools run under an address-space ceiling, and
 * their stderr is discarded (a hostile file emits gigabytes of it). The tools
 * run asynchronously: these reads happen inside staff requests, and a
 * synchronous call would stall every request the process is serving.
 */
import { MAX_RENDER_MEMORY_KB, withPrivateTempDir } from "@/lib/vlm-extract"

export interface PdfInfo {
  producer: string | null
  creator: string | null
  createdAt: string | null
  modifiedAt: string | null
  pages: number
  /**
   * A field printed more than once: a metadata value carried a newline and
   * forged the lines after it. The four fields above are then null, not trusted.
   */
  metadataAmbiguous: boolean
}

const TOOL_TIMEOUT_MS = 30_000
const TEXT_MAX_BUFFER = 32 * 1024 * 1024
/** The text layer is only read for statements this long; the corpus's longest genuine one was 90 pages. */
export const TEXT_MAX_PAGES = 120

async function runBounded(tool: string, args: string[]): Promise<string> {
  const { execFile } = await import("child_process")
  const quoted = args.map((_, i) => `"$${i + 1}"`).join(" ")
  return new Promise((resolve, reject) => {
    execFile(
      "sh",
      ["-c", `ulimit -v ${MAX_RENDER_MEMORY_KB}; exec ${tool} ${quoted} 2>/dev/null`, "sh", ...args],
      { timeout: TOOL_TIMEOUT_MS, maxBuffer: TEXT_MAX_BUFFER, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })
}

const FIELDS = ["Producer", "Creator", "CreationDate", "ModDate", "Pages"] as const

function field(out: string, name: string): string | null {
  // [ \t]*, not \s*: an empty field must not swallow the newline and read the next line.
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(out)
  const v = m?.[1].trim()
  return v ? v : null
}

export function parsePdfInfo(out: string): PdfInfo {
  const metadataAmbiguous = FIELDS.some((f) => (out.match(new RegExp(`^${f}:`, "gm")) ?? []).length > 1)
  const trusted = (name: string) => (metadataAmbiguous ? null : field(out, name))
  return {
    producer: trusted("Producer"),
    creator: trusted("Creator"),
    createdAt: trusted("CreationDate"),
    modifiedAt: trusted("ModDate"),
    // A forged page count would steer which reader runs: an ambiguous one reads
    // as too many pages, so the file goes to manual review rather than a reader.
    pages: metadataAmbiguous ? Number.MAX_SAFE_INTEGER : Number(field(out, "Pages") ?? 0),
    metadataAmbiguous,
  }
}

/** One word of the text layer with its box, in PDF points from the top left. */
export interface PdfWord {
  text: string
  xMin: number
  xMax: number
  yMin: number
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" }

/** Words per page from `pdftotext -bbox` output. */
export function parseBbox(html: string): PdfWord[][] {
  return html.split("<page ").slice(1).map((page) =>
    [...page.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="[\d.]+">([^<]*)<\/word>/g)].map((m) => ({
      text: m[4].replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e]),
      xMin: Number(m[1]),
      xMax: Number(m[3]),
      yMin: Number(m[2]),
    })),
  )
}

export interface PdfContent {
  info: PdfInfo
  /** `pdftotext -layout`, one string per page; empty when the file is over TEXT_MAX_PAGES. */
  pages: string[]
  /** `pdftotext -bbox`, the same text as positioned words. */
  words: PdfWord[][]
}

/** pdfinfo facts and, for a file of at most TEXT_MAX_PAGES, the per-page text layer. */
export async function readPdf(bytes: Buffer): Promise<PdfContent> {
  const { writeFileSync } = await import("fs")
  const { join } = await import("path")
  return withPrivateTempDir(async (dir) => {
    const path = join(dir, "statement.pdf")
    writeFileSync(path, bytes, { mode: 0o600 })
    const info = parsePdfInfo(await runBounded("pdfinfo -isodates", [path]))
    if (info.pages > TEXT_MAX_PAGES) return { info, pages: [], words: [] }
    const text = await runBounded(`pdftotext -l ${TEXT_MAX_PAGES} -layout -enc UTF-8`, [path, "-"])
    // pdftotext ends every page with a form feed, so the last split is empty.
    const pages = text.split("\f")
    if (pages.length > 1 && pages[pages.length - 1].trim() === "") pages.pop()
    const words = parseBbox(await runBounded(`pdftotext -l ${TEXT_MAX_PAGES} -bbox -enc UTF-8`, [path, "-"]))
    return { info, pages, words }
  })
}

const PDF_SPACE = "[\\0\\t\\n\\f\\r ]"
/** A trailer dictionary through %%EOF: only names, integers, references and hex strings, so no object hides in it. */
const TRAILER_TO_EOF =
  `trailer${PDF_SPACE}*<<((?:${PDF_SPACE}|/[A-Za-z0-9]+(?![A-Za-z0-9])|\\d+(?!\\d)|R|\\[|\\]|<[0-9A-Fa-f]*>)*)>>` +
  `${PDF_SPACE}*startxref${PDF_SPACE}+(\\d+)${PDF_SPACE}+%%EOF$`
/** A save of only a trailer: xref subsections with no entry but object 0's free-list head (freeing any other deletes it). */
const TRAILER_ONLY_SAVE = new RegExp(
  `^(${PDF_SPACE}*)xref${PDF_SPACE}+(?:(?:\\d+ +0|0 +1${PDF_SPACE}+0000000000 65535 f)${PDF_SPACE}+)*${TRAILER_TO_EOF}`,
)
const PREVIOUS_TRAILER = new RegExp(`^${TRAILER_TO_EOF}`)
const TRAILER_ENTRY = new RegExp(
  `${PDF_SPACE}*/([A-Za-z0-9]+)${PDF_SPACE}*(\\d+${PDF_SPACE}+\\d+${PDF_SPACE}+R|\\d+|\\[(?:${PDF_SPACE}|<[0-9A-Fa-f]*>)*\\])${PDF_SPACE}*`,
  "y",
)
/** Repeated from the previous trailer byte for byte: any change re-points the document, shrinks it or encrypts it. */
const REPEATED_KEYS = ["Root", "Info", "ID", "Size", "Encrypt"]
const NO_OP_KEYS = new Set([...REPEATED_KEYS, "Prev", "XRefStm"])
const XREF_STREAM_TYPE = new RegExp(`/Type${PDF_SPACE}*/XRef(?![A-Za-z0-9])`, "g")
/** Word's is under 200 bytes; a longer section, or previous trailer, is counted without being matched. */
const NO_OP_SAVE_MAX_BYTES = 2048

/** Key → value text of a trailer of name/value pairs; null for anything else or a repeated key. */
function trailerEntries(body: string): Map<string, string> | null {
  const entries = new Map<string, string>()
  TRAILER_ENTRY.lastIndex = 0
  while (TRAILER_ENTRY.lastIndex < body.length) {
    const m = TRAILER_ENTRY.exec(body)
    if (!m || entries.has(m[1])) return null
    entries.set(m[1], m[2])
  }
  return entries
}

/** Whether `offset` starts the original save's only /Type /XRef stream object. */
/** The original save's end and, found on first use (one read however many saves ask), its only /Type /XRef. */
interface OriginalSave {
  end: number
  xrefType?: number | null
}

function onlyXrefType(bytes: Buffer, original: OriginalSave): number | null {
  if (original.xrefType === undefined) {
    const types = [...bytes.subarray(0, original.end).toString("latin1").matchAll(XREF_STREAM_TYPE)]
    original.xrefType = types.length === 1 ? types[0].index : null
  }
  return original.xrefType
}

function isOriginalsXrefStream(bytes: Buffer, offset: number, original: OriginalSave): boolean {
  const type = onlyXrefType(bytes, original)
  if (type === null || offset >= original.end) return false
  const head = bytes.subarray(offset, Math.min(original.end, offset + 1024)).toString("latin1")
  const at = type - offset
  return new RegExp(`^\\d+${PDF_SPACE}+\\d+${PDF_SPACE}+obj${PDF_SPACE}*<<`).test(head) && at > 0 && at < head.length &&
    !/stream|endobj/.test(head.slice(0, at))
}

/**
 * Whether the save in [start, end) is a no-op against the one before it, which
 * began at `prevStart`. Word's "hybrid-xref" save appends one to every file:
 * no object, no xref entry, the previous trailer's /Root, /Info, /ID, /Size
 * and /Encrypt repeated, /Prev at the previous xref, its startxref at its own
 * xref, and /XRefStm (if any) the previous one or the original's xref stream.
 * Nothing a reader resolves through it differs from the save before it.
 */
function isNoOpSave(bytes: Buffer, prevStart: number, start: number, end: number, original: OriginalSave): boolean {
  if (end - start > NO_OP_SAVE_MAX_BYTES) return false
  const save = TRAILER_ONLY_SAVE.exec(bytes.subarray(start, end).toString("latin1"))
  if (!save) return false
  // Searched only within the previous save's last 2 KB: a scan back to byte 0 per section is quadratic.
  const from = Math.max(prevStart, start - NO_OP_SAVE_MAX_BYTES)
  const t = bytes.subarray(from, start).lastIndexOf("trailer")
  if (t < 0) return false
  const previous = PREVIOUS_TRAILER.exec(bytes.subarray(from + t, start).toString("latin1"))
  const entries = trailerEntries(save[2])
  const before = previous && trailerEntries(previous[1])
  if (!previous || !entries || !before || [...entries.keys()].some((k) => !NO_OP_KEYS.has(k))) return false
  if (REPEATED_KEYS.some((k) => entries.get(k) !== before.get(k))) return false
  if (Number(entries.get("Prev")) !== Number(previous[2]) || Number(save[3]) !== start + save[1].length) return false
  const xrefStm = entries.get("XRefStm")
  return xrefStm === undefined || xrefStm === before.get("XRefStm") || isOriginalsXrefStream(bytes, Number(xrefStm), original)
}

/**
 * Revisions appended after the original save. Each save ends with %%EOF and a
 * startxref, and a linearized file legitimately carries two of each from its
 * first save. Both are counted and the larger taken: a reader still follows an
 * appended revision that omits its %%EOF. Linearized
 * means its FIRST object is the linearization dictionary — not merely that the
 * word appears early, which a comment could fake to hide one appended save.
 * A save that ends in %%EOF and is a no-op (isNoOpSave) is not counted.
 */
export function countIncrementalUpdates(bytes: Buffer): number {
  const count = (marker: string) => {
    let n = 0
    for (let i = bytes.indexOf(marker); i >= 0; i = bytes.indexOf(marker, i + marker.length)) n++
    return n
  }
  const head = bytes.subarray(0, 2048).toString("latin1")
  const linearized = /^%PDF-\d\.\d[^\n\r]*[\r\n]+(?:%[^\r\n]*[\r\n]+)*\s*\d+\s+0\s+obj\s*<<\s*\/Linearized\b/.test(head)
  const eofEnds: number[] = []
  for (let i = bytes.indexOf("%%EOF"); i >= 0; i = bytes.indexOf("%%EOF", i + 5)) eofEnds.push(i + 5)
  const original: OriginalSave = { end: eofEnds[linearized ? 1 : 0] ?? bytes.length }
  let noOp = 0
  for (let k = 1; k < eofEnds.length; k++) {
    if (isNoOpSave(bytes, k >= 2 ? eofEnds[k - 2] : 0, eofEnds[k - 1], eofEnds[k], original)) noOp++
  }
  const saves = Math.max(eofEnds.length, count("startxref"))
  return Math.max(0, saves - 1 - (linearized ? 1 : 0) - noOp)
}
