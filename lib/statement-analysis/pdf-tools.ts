/**
 * poppler calls for the statement reader: document facts (pdfinfo) and the
 * text layer (pdftotext -layout), one string per page.
 *
 * Same containment as lib/vlm-extract.ts: the bytes go to a 0700 temp dir that
 * is removed on every path, the tools run under an address-space ceiling, and
 * their stderr is discarded (a hostile file emits gigabytes of it).
 */
import { MAX_RENDER_MEMORY_KB, withPrivateTempDir } from "@/lib/vlm-extract"

export interface PdfInfo {
  producer: string | null
  creator: string | null
  createdAt: string | null
  modifiedAt: string | null
  pages: number
}

const TOOL_TIMEOUT_MS = 30_000
const TEXT_MAX_BUFFER = 32 * 1024 * 1024

async function runBounded(tool: string, args: string[]): Promise<string> {
  const { execFileSync } = await import("child_process")
  const quoted = args.map((_, i) => `"$${i + 1}"`).join(" ")
  return execFileSync(
    "sh",
    ["-c", `ulimit -v ${MAX_RENDER_MEMORY_KB}; exec ${tool} ${quoted}`, "sh", ...args],
    { timeout: TOOL_TIMEOUT_MS, maxBuffer: TEXT_MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
  )
}

function field(out: string, name: string): string | null {
  // [ \t]*, not \s*: an empty field must not swallow the newline and read the next line.
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(out)
  const v = m?.[1].trim()
  return v ? v : null
}

export function parsePdfInfo(out: string): PdfInfo {
  return {
    producer: field(out, "Producer"),
    creator: field(out, "Creator"),
    createdAt: field(out, "CreationDate"),
    modifiedAt: field(out, "ModDate"),
    pages: Number(field(out, "Pages") ?? 0),
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
  /** `pdftotext -layout`, one string per page. */
  pages: string[]
  /** `pdftotext -bbox`, the same text as positioned words. */
  words: PdfWord[][]
}

/** pdfinfo facts and the per-page text layer of a PDF. */
export async function readPdf(bytes: Buffer): Promise<PdfContent> {
  const { writeFileSync } = await import("fs")
  const { join } = await import("path")
  return withPrivateTempDir(async (dir) => {
    const path = join(dir, "statement.pdf")
    writeFileSync(path, bytes, { mode: 0o600 })
    const info = parsePdfInfo(await runBounded("pdfinfo -isodates", [path]))
    const text = await runBounded("pdftotext -layout -enc UTF-8", [path, "-"])
    // pdftotext ends every page with a form feed, so the last split is empty.
    const pages = text.split("\f")
    if (pages.length > 1 && pages[pages.length - 1].trim() === "") pages.pop()
    const words = parseBbox(await runBounded("pdftotext -bbox -enc UTF-8", [path, "-"]))
    return { info, pages, words }
  })
}

/**
 * Revisions appended after the original save. Each save ends with %%EOF, and a
 * linearized file legitimately carries two from its first save.
 */
export function countIncrementalUpdates(bytes: Buffer): number {
  let eofs = 0
  for (let i = bytes.indexOf("%%EOF"); i >= 0; i = bytes.indexOf("%%EOF", i + 5)) eofs++
  const linearized = bytes.subarray(0, 2048).includes("/Linearized")
  return Math.max(0, eofs - 1 - (linearized ? 1 : 0))
}
