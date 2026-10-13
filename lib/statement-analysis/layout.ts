/**
 * Helpers shared by the text readers, which read `pdftotext -layout` output:
 * one string per page, columns preserved as runs of spaces.
 */

export interface Token {
  text: string
  /** Column just past the token's last character. */
  end: number
}

/** Every match of `re` (which must be global) with the column it ends at. */
export function tokens(line: string, re: RegExp, from = 0): Token[] {
  const out: Token[] = []
  re.lastIndex = from
  for (let m = re.exec(line); m; m = re.exec(line)) out.push({ text: m[0], end: m.index + m[0].length })
  return out
}

/** The left-hand text of a line: what precedes the first run of 3+ spaces. */
export function leftSegment(line: string): string {
  return line.trim().split(/\s{3,}/)[0] ?? ""
}

const TITLES = /^(MR|MRS|MS|MISS|DR|MNR|ME|MEV|PROF)\.?\s+[A-Z]/i

/**
 * The account holder from the address block: the first left-hand segment on
 * the page that begins with a title. Statements print the holder as
 * "MR J SOAP"; the title is dropped so name matching sees the name.
 */
export function holderFromTitleLine(page: string): string | null {
  for (const line of page.split("\n").slice(0, 40)) {
    const seg = leftSegment(line)
    if (TITLES.test(seg)) return seg.replace(/^\S+\s+/, "").trim() || null
  }
  return null
}

/** Last four digits of the first account number a pattern captures. */
export function last4(text: string, re: RegExp): string | null {
  const m = re.exec(text)
  return m ? m[1].slice(-4) : null
}

/** dd/mm/yyyy → yyyy-mm-dd, or null when it is not a real date. */
export function isoFromDmy(dmy: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dmy)
  if (!m) return null
  return validIso(Number(m[3]), Number(m[2]), Number(m[1]))
}

export function validIso(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

export const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** "5 June 2026" / "05 Jun 2026" → 2026-06-05. */
export function isoFromDayMonthYear(text: string): string | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/.exec(text.trim())
  if (!m) return null
  const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1
  return mo > 0 ? validIso(Number(m[3]), mo, Number(m[1])) : null
}
