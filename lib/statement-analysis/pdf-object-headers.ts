/**
 * Where a PDF's bytes define uncompressed objects ("N G obj"), found in one
 * pass for pdf-revisions.ts. A tokenizer, not a regex: each byte is read once,
 * a comment is skipped once, so a hostile file costs time linear in its size.
 *
 * It reads every byte, string and stream contents included, so it may report a
 * header no reader would follow; that only makes pdf-revisions.ts count a save.
 * It can also miss one: a "%" in binary stream data reads as a comment and may
 * hide a header after it on that line. Only an original built to be forged
 * places a header there, which is out of scope (pdf-revisions.ts header).
 */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
/** ( ) < > [ ] { } / — each ends the token before it; % starts a comment. */
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f])
const PERCENT = 0x25
/** Tokens no longer than this are checked as read; a longer one only once it starts like an integer. */
const INTEGER_PREFIX = 16
const INTEGER = /^[+-]?\d+$/
/** An xref stream names an object in at most 6 bytes (< 2^48): no more significant digits than this. */
const MAX_OBJECT_NUMBER_DIGITS = 15

/**
 * The object number an integer token names, read as poppler reads it (a sign,
 * any number of leading zeros); null when no xref stream entry could name it,
 * so a huge value is never rounded onto one that can.
 */
function objectNumber(token: string): number | null {
  if (token.startsWith("-")) return /^-0+$/.test(token) ? 0 : null
  const digits = token.replace(/^\+?0*/, "")
  return digits.length <= MAX_OBJECT_NUMBER_DIGITS ? Number(digits) : null
}

/** Object number → offsets of its "N G obj" headers in bytes [0, end). */
export function objectHeaders(bytes: Buffer, end: number): Map<number, number[]> {
  const headers = new Map<number, number[]>()
  // The two tokens before the current one, when they were both integers: [object number, its offset].
  let before: [number | null, number] | null = null
  let last: [number | null, number] | null = null
  for (let i = 0; i < end;) {
    const c = bytes[i]
    if (WHITESPACE.has(c)) {
      i++
    } else if (c === PERCENT) {
      // A comment is whitespace to the end of its line.
      while (i < end && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++
    } else if (DELIMITERS.has(c)) {
      before = last = null
      i++
    } else {
      const start = i
      while (i < end && !WHITESPACE.has(bytes[i]) && !DELIMITERS.has(bytes[i]) && bytes[i] !== PERCENT) i++
      const token = bytes.toString("latin1", start, Math.min(i, start + INTEGER_PREFIX))
      const whole = i - start > INTEGER_PREFIX && INTEGER.test(token) ? bytes.toString("latin1", start, i) : token
      if (INTEGER.test(whole)) {
        before = last
        last = [objectNumber(whole), start]
        continue
      }
      if (token === "obj" && i - start === 3 && before && last && before[0] !== null) {
        const at = headers.get(before[0])
        if (at) at.push(before[1])
        else headers.set(before[0], [before[1]])
      }
      before = last = null
    }
  }
  return headers
}
