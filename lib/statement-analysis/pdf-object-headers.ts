/**
 * Where a PDF's bytes define uncompressed objects ("N G obj"), found in one
 * pass for pdf-revisions.ts. A tokenizer, not a regex: each byte is read once,
 * a comment is skipped once, so a hostile file costs time linear in its size.
 *
 * It reads every byte, string and stream contents included, so it may report a
 * header no reader would follow. That only makes pdf-revisions.ts count a save
 * it might have let through: the safe direction.
 */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
/** ( ) < > [ ] { } / — each ends the token before it; % starts a comment. */
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f])
const PERCENT = 0x25
/** Longer digit runs cannot be an object or generation number. */
const MAX_NUMBER_DIGITS = 10

/** Object number → offsets of its "N G obj" headers in bytes [0, end). */
export function objectHeaders(bytes: Buffer, end: number): Map<number, number[]> {
  const headers = new Map<number, number[]>()
  // The two tokens before the current one, when they were both integers: [number, its offset].
  let before: [number, number] | null = null
  let last: [number, number] | null = null
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
      const token = bytes.toString("latin1", start, Math.min(i, start + MAX_NUMBER_DIGITS + 1))
      if (i - start <= MAX_NUMBER_DIGITS && /^\d+$/.test(token)) {
        before = last
        last = [Number(token), start]
        continue
      }
      if (token === "obj" && i - start === 3 && before && last) {
        const at = headers.get(before[0])
        if (at) at.push(before[1])
        else headers.set(before[0], [before[1]])
      }
      before = last = null
    }
  }
  return headers
}
