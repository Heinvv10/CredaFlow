/**
 * Journal CSVs, rendered only from a CLOSED batch's stored lines: the same
 * batch always produces the same bytes, and `linesDigest` is the seal the
 * batch stored when it closed, re-checked before anything is served.
 *
 * Two layouts:
 *  - generic: date, account, debit, credit, reference, description (ISO dates)
 *  - sage: a Sage-style journal layout (dd/mm/yyyy, tax code column). Built to
 *    the common shape of Sage journal imports; not yet proven against a Sage
 *    company's import screen.
 */
import { createHash } from "node:crypto"

export interface StoredLine {
  lineNo: number
  postingDate: string
  accountCode: string
  taxCode: string | null
  debitCents: number
  creditCents: number
  reference: string
  description: string
  eventKey: string
}

export type CsvFormat = "generic" | "sage"

export function isCsvFormat(value: unknown): value is CsvFormat {
  return value === "generic" || value === "sage"
}

/** RFC 4180 quoting; a text cell that a spreadsheet would run as a formula is prefixed with '. */
export function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/g, '""')}"`
}

export function rands(cents: number): string {
  if (cents === 0) return ""
  const sign = cents < 0 ? "-" : ""
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`
}

function ordered(lines: StoredLine[]): StoredLine[] {
  return [...lines].sort((a, b) => a.lineNo - b.lineNo)
}

/** Canonical digest of a batch's lines, stored at close and checked before every download. */
export function linesDigest(lines: StoredLine[]): string {
  const hash = createHash("sha256")
  for (const l of ordered(lines)) {
    hash.update(JSON.stringify([l.lineNo, l.postingDate, l.accountCode, l.taxCode, l.debitCents, l.creditCents, l.reference, l.description, l.eventKey]))
    hash.update("\n")
  }
  return hash.digest("hex")
}

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

export function renderCsv(format: CsvFormat, lines: StoredLine[]): string {
  const rows = ordered(lines)
  if (format === "sage") {
    return [
      "Date,Reference,Account Code,Description,Tax Code,Debit,Credit",
      ...rows.map((l) => [dmy(l.postingDate), cell(l.reference), cell(l.accountCode), cell(l.description), cell(l.taxCode ?? ""), rands(l.debitCents), rands(l.creditCents)].join(",")),
    ].join("\r\n") + "\r\n"
  }
  return [
    "Date,Account,Debit,Credit,Reference,Description",
    ...rows.map((l) => [l.postingDate, cell(l.accountCode), rands(l.debitCents), rands(l.creditCents), cell(l.reference), cell(l.description)].join(",")),
  ].join("\r\n") + "\r\n"
}
