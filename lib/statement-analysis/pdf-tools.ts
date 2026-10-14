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

/**
 * Revisions appended after the original save. Each save ends with %%EOF and a
 * startxref, and a linearized file legitimately carries two of each from its
 * first save. Both are counted and the larger taken: a reader still follows an
 * appended revision that omits its %%EOF. Linearized
 * means its FIRST object is the linearization dictionary — not merely that the
 * word appears early, which a comment could fake to hide one appended save.
 */
export function countIncrementalUpdates(bytes: Buffer): number {
  const count = (marker: string) => {
    let n = 0
    for (let i = bytes.indexOf(marker); i >= 0; i = bytes.indexOf(marker, i + marker.length)) n++
    return n
  }
  const saves = Math.max(count("%%EOF"), count("startxref"))
  const head = bytes.subarray(0, 2048).toString("latin1")
  const linearized = /^%PDF-\d\.\d[^\n\r]*[\r\n]+(?:%[^\r\n]*[\r\n]+)*\s*\d+\s+0\s+obj\s*<<\s*\/Linearized\b/.test(head)
  return Math.max(0, saves - 1 - (linearized ? 1 : 0))
}
