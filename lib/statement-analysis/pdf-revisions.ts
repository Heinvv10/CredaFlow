/**
 * Saves appended to a PDF after its original one, for DOCUMENT_AUTHENTICITY's
 * INCREMENTAL_UPDATE. Each is counted unless it is a no-op against the save
 * before it, as Word's "hybrid-xref" save is. Every check reads a bounded
 * window or runs once per file, so a hostile file of many saves costs time
 * linear in its size.
 *
 * Scope: this catches an edit appended to a genuine file. An original the
 * forger built (shadow objects, decoy trailers, a doctored xref stream) is out
 * of scope: whoever builds the original can forge its content with no append.
 * Hardening against such originals stopped here by decision (PR #95).
 */
import { inflateSync } from "zlib"
import { objectHeaders } from "./pdf-object-headers"

const PDF_SPACE = "[\\0\\t\\n\\f\\r ]"
const PDF_SPACE_BYTES = [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]
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
/** Word's is under 200 bytes; a longer section, or previous trailer, is counted without being matched. */
const NO_OP_SAVE_MAX_BYTES = 2048

const XREF_STREAM_TYPE = new RegExp(`/Type${PDF_SPACE}*/XRef(?![A-Za-z0-9])`, "g")
/** An xref stream object's dictionary up to its data; no nested dictionary (/DecodeParms), so none of Word's has one. */
const XREF_STREAM_HEAD = new RegExp(
  `^\\d+${PDF_SPACE}+\\d+${PDF_SPACE}+obj${PDF_SPACE}*<<([^<>]*(?:<[0-9A-Fa-f]*>[^<>]*)*)>>${PDF_SPACE}*stream(?:\\r\\n|\\n)`,
)
const XREF_STREAM_ENTRY = new RegExp(
  `${PDF_SPACE}*/([A-Za-z0-9]+)${PDF_SPACE}*(\\d+${PDF_SPACE}+\\d+${PDF_SPACE}+R|\\d+|/[A-Za-z0-9]+|\\[(?:${PDF_SPACE}|\\d+(?!\\d)|<[0-9A-Fa-f]*>)*\\])${PDF_SPACE}*`,
  "y",
)
/** The keys Word's xref stream carries, /Index aside: no /Prev, /DecodeParms or anything else to follow. */
const XREF_STREAM_KEYS = new Set(["Type", "Size", "W", "Index", "Root", "Info", "ID", "Filter", "Length"])
/** Decoded; the corpus's largest Word xref stream is under 200 KB. */
const XREF_STREAM_MAX_BYTES = 8 * 1024 * 1024

/** The file and what is found in it on first use, once however many saves ask. */
interface Revisions {
  bytes: Buffer
  /** End of the original save: its first %%EOF, or its second when linearized. */
  originalEnd: number
  trailers?: number[]
  xrefType?: number | null
  /** Offsets of each object number's uncompressed "N G obj" headers in the original. */
  headers?: Map<number, number[]>
}

/** Key → value text of a dictionary of name/value pairs; null for anything else or a repeated key. */
function dictEntries(body: string, entry: RegExp): Map<string, string> | null {
  const entries = new Map<string, string>()
  entry.lastIndex = 0
  while (entry.lastIndex < body.length) {
    const m = entry.exec(body)
    if (!m || entries.has(m[1])) return null
    entries.set(m[1], m[2])
  }
  return entries
}

function trailerEntries(body: string): Map<string, string> | null {
  return dictEntries(body, TRAILER_ENTRY)
}

/** The first `trailer` keyword at or after `offset`, or -1. */
function firstTrailerFrom(r: Revisions, offset: number): number {
  if (!r.trailers) {
    r.trailers = []
    for (let i = r.bytes.indexOf("trailer"); i >= 0; i = r.bytes.indexOf("trailer", i + 7)) r.trailers.push(i)
  }
  const { trailers } = r
  let [lo, hi] = [0, trailers.length]
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (trailers[mid] < offset) lo = mid + 1
    else hi = mid
  }
  return lo < trailers.length ? trailers[lo] : -1
}

/** Whether `offset` starts the original save's only /Type /XRef stream object. */
function isOriginalsXrefStream(r: Revisions, offset: number): boolean {
  if (r.xrefType === undefined) {
    const types = [...r.bytes.subarray(0, r.originalEnd).toString("latin1").matchAll(XREF_STREAM_TYPE)]
    r.xrefType = types.length === 1 ? types[0].index : null
  }
  if (r.xrefType === null || offset >= r.originalEnd) return false
  const head = r.bytes.subarray(offset, Math.min(r.originalEnd, offset + 1024)).toString("latin1")
  const at = r.xrefType - offset
  return new RegExp(`^\\d+${PDF_SPACE}+\\d+${PDF_SPACE}+obj${PDF_SPACE}*<<`).test(head) && at > 0 && at < head.length &&
    !/stream|endobj/.test(head.slice(0, at))
}

/** The classic xref table at `offset` ending at `trailerAt`: its in-use entries (object → [offset, generation]) and its entry count; null unless exactly one. */
function classicTable(bytes: Buffer, offset: number, trailerAt: number): { inUse: Map<number, [number, number]>; entries: number } | null {
  const tokens = bytes.subarray(offset, trailerAt).toString("latin1").split(new RegExp(`${PDF_SPACE}+`)).filter(Boolean)
  if (tokens[0] !== "xref") return null
  const inUse = new Map<number, [number, number]>()
  let entries = 0
  for (let i = 1; i < tokens.length;) {
    const [first, n] = [tokens[i], tokens[i + 1] ?? ""]
    if (!/^\d+$/.test(first) || !/^\d+$/.test(n)) return null
    i += 2
    for (let k = 0; k < Number(n); k++, i += 3, entries++) {
      const [at, gen, type] = [tokens[i] ?? "", tokens[i + 1] ?? "", tokens[i + 2]]
      if (!/^\d{10}$/.test(at) || !/^\d{5}$/.test(gen) || (type !== "n" && type !== "f")) return null
      if (inUse.has(Number(first) + k)) return null
      if (type === "n") inUse.set(Number(first) + k, [Number(at), Number(gen)])
    }
  }
  return { inUse, entries }
}

const int = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : NaN)
const ints = (v: string | undefined) => (v?.startsWith("[") ? v.slice(1, -1).split(new RegExp(`${PDF_SPACE}+`)).filter(Boolean).map(int) : null)

/**
 * Hands each entry of the xref stream at `offset` to `visit` in place, none
 * kept, and stops at the first it refuses. False then, or unless the stream
 * decodes exactly as Word's does with at most `maxEntries` entries: a few KB
 * of deflate can declare millions.
 */
function everyXrefStreamEntry(
  bytes: Buffer, offset: number, end: number, maxEntries: number,
  visit: (num: number, type: number, field2: number, field3: number) => boolean,
): boolean {
  const head = XREF_STREAM_HEAD.exec(bytes.subarray(offset, Math.min(end, offset + 1024)).toString("latin1"))
  const dict = head && dictEntries(head[1], XREF_STREAM_ENTRY)
  if (!head || !dict || [...dict.keys()].some((k) => !XREF_STREAM_KEYS.has(k)) || dict.get("Type") !== "/XRef") return false
  const filter = dict.get("Filter")
  const [length, size, w] = [int(dict.get("Length")), int(dict.get("Size")), ints(dict.get("W"))]
  const index = dict.has("Index") ? ints(dict.get("Index")) : [0, size]
  if ((filter !== undefined && filter !== "/FlateDecode") || !w || w.length !== 3 || w.some((x) => !(x <= 6)) || w[1] === 0) return false
  if (!index || index.length % 2 !== 0 || index.some((x) => !Number.isSafeInteger(x)) || !Number.isSafeInteger(length)) return false
  const width = w[0] + w[1] + w[2]
  const total = index.reduce((sum, x, i) => (i % 2 ? sum + x : sum), 0)
  if (total > maxEntries || total * width > XREF_STREAM_MAX_BYTES) return false
  const dataAt = offset + head[0].length
  const after = bytes.subarray(dataAt + length, dataAt + length + 16).toString("latin1")
  if (dataAt + length > end || !new RegExp(`^${PDF_SPACE}*endstream`).test(after)) return false
  let raw: Buffer
  try {
    const data = bytes.subarray(dataAt, dataAt + length)
    raw = filter ? inflateSync(data, { maxOutputLength: Math.max(1, total * width) }) : data
  } catch {
    // Corrupt, or longer than its entries: not Word's stream, so the save stays counted.
    return false
  }
  if (raw.length !== total * width) return false
  const field = (at: number, n: number, absent: number) => (n === 0 ? absent : raw.readUIntBE(at, n))
  for (let i = 0, at = 0; i < index.length; i += 2) {
    for (let k = 0; k < index[i + 1]; k++, at += width) {
      if (!visit(index[i] + k, field(at, w[0], 1), field(at + w[0], w[1], 0), field(at + w[0] + w[1], w[2], 0))) return false
    }
  }
  return true
}

const OBJECT_STREAM = new RegExp(`^\\d+${PDF_SPACE}+\\d+${PDF_SPACE}+obj${PDF_SPACE}*<<[^>]*?/Type${PDF_SPACE}*/ObjStm(?![A-Za-z0-9])`)

function bodyHeaders(r: Revisions): Map<number, number[]> {
  r.headers ??= objectHeaders(r.bytes, r.originalEnd)
  return r.headers
}

/**
 * Whether the stream's entry for an object the table frees or lacks adds
 * nothing a reader could already see. Word maps those as compressed objects
 * (type 2), none of which the body also defines, and their object streams
 * (type 1), each at its one header. Anything else could stand in for an
 * object the body defines, as a page swapped in from an object stream does.
 * What a compressed object holds is not checked: only an original built to
 * be forged can put content there, which is out of scope (file header).
 */
function unlistedEntryAgrees(r: Revisions, num: number, type: number, at: number): boolean {
  const headers = bodyHeaders(r).get(num)
  if (type === 0) return true
  if (type === 2) return !headers
  return headers?.length === 1 && headers[0] === at && OBJECT_STREAM.test(r.bytes.toString("latin1", at, Math.min(r.originalEnd, at + 300)))
}

/** Word's stream has one entry fewer than its table; a few more are allowed. */
const XREF_STREAM_EXTRA_ENTRIES = 16

/**
 * Whether an /XRefStm adds nothing: a reader takes the appended save's /XRefStm
 * before the table at /Prev, so it must be the original's only xref stream,
 * decoded exactly, putting every object the table has in use where the table
 * does, and objects it frees or lacks only where unlistedEntryAgrees allows.
 */
function xrefStreamAgrees(r: Revisions, xrefStm: number, tableAt: number, trailerAt: number): boolean {
  if (!isOriginalsXrefStream(r, xrefStm)) return false
  const table = classicTable(r.bytes, tableAt, trailerAt)
  // The whole header the table lists at exactly this offset: "1 0 obj" inside "11 0 obj" parses too.
  const number = /^\d+/.exec(r.bytes.toString("latin1", xrefStm, xrefStm + 20))?.[0]
  const tokenStart = xrefStm === 0 || PDF_SPACE_BYTES.includes(r.bytes[xrefStm - 1])
  if (!table || !number || !tokenStart || table.inUse.get(Number(number))?.[0] !== xrefStm) return false
  return everyXrefStreamEntry(r.bytes, xrefStm, r.originalEnd, table.entries + XREF_STREAM_EXTRA_ENTRIES, (num, type, at, gen) => {
    const listed = table.inUse.get(num)
    return listed ? type === 1 && at === listed[0] && gen === listed[1] : unlistedEntryAgrees(r, num, type, at)
  })
}

/**
 * Whether the save in [start, end) is a no-op against the one before it, which
 * began at `prevStart`. Word's "hybrid-xref" save appends one to every file:
 * no object, no xref entry, the previous trailer's /Root, /Info, /ID, /Size
 * and /Encrypt repeated, /Prev at the previous xref, its startxref at its own
 * xref, and /XRefStm (if any) the previous one or the original's xref stream.
 */
function isNoOpSave(r: Revisions, prevStart: number, start: number, end: number): boolean {
  const { bytes } = r
  if (end - start > NO_OP_SAVE_MAX_BYTES) return false
  const save = TRAILER_ONLY_SAVE.exec(bytes.subarray(start, end).toString("latin1"))
  if (!save) return false
  // Searched only within the previous save's last 2 KB: a scan back to byte 0 per section is quadratic.
  const from = Math.max(prevStart, start - NO_OP_SAVE_MAX_BYTES)
  const t = bytes.subarray(from, start).lastIndexOf("trailer") + from
  if (t < from) return false
  const previous = PREVIOUS_TRAILER.exec(bytes.subarray(t, start).toString("latin1"))
  const entries = trailerEntries(save[2])
  const before = previous && trailerEntries(previous[1])
  if (!previous || !entries || !before || [...entries.keys()].some((k) => !NO_OP_KEYS.has(k))) return false
  if (REPEATED_KEYS.some((k) => entries.get(k) !== before.get(k))) return false
  const tableAt = Number(previous[2])
  if (Number(entries.get("Prev")) !== tableAt || Number(save[3]) !== start + save[1].length) return false
  // A reader takes the first trailer after the xref at /Prev: a later one in the same save is a decoy.
  if (bytes.toString("latin1", tableAt, tableAt + 4) !== "xref" || firstTrailerFrom(r, tableAt) !== t) return false
  const xrefStm = entries.get("XRefStm")
  if (xrefStm === undefined || xrefStm === before.get("XRefStm")) return true
  // Word adds one only in the save straight after an original that had none (its table is then the whole table).
  return start === r.originalEnd && !before.has("XRefStm") && !before.has("Prev") && xrefStreamAgrees(r, int(xrefStm), tableAt, t)
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
  const r: Revisions = { bytes, originalEnd: eofEnds[linearized ? 1 : 0] ?? bytes.length }
  let noOp = 0
  for (let k = 1; k < eofEnds.length; k++) {
    if (isNoOpSave(r, k >= 2 ? eofEnds[k - 2] : 0, eofEnds[k - 1], eofEnds[k])) noOp++
  }
  const saves = Math.max(eofEnds.length, count("startxref"))
  return Math.max(0, saves - 1 - (linearized ? 1 : 0) - noOp)
}
