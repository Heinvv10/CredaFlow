/**
 * The strict CSV reader for an uploaded valuation guide (docs/asset-finance/
 * SLICE5.md part C). UTF-8 (an optional BOM), CRLF or LF, the exact header
 * below, six fields per line; a field may be quoted (a doubled quote is a
 * quote) but never spans lines. Money is whole cents. Every problem is found
 * and reported per line; nothing is stored unless the whole file is clean.
 * The database repeats the row rules (ValuationGuideRow CHECKs and key).
 */
import type { GuideProblem, GuideRow } from "./types"

export const GUIDE_CSV_HEADER = "make,model,year,variant,trade_cents,retail_cents"
export const MAX_GUIDE_ROWS = 20_000
export const MAX_GUIDE_BYTES = 5 * 1024 * 1024
export const MAX_SHOWN_PROBLEMS = 200

const COLUMNS = 6
const MAX_TEXT = 100
const MAX_CENTS = 2_147_483_647
const CONTROL = /[\u0000-\u001f\u007f]/
const FORMULA = /^[=+\-@]/

export type GuideCsvResult = { ok: true; rows: GuideRow[] } | { ok: false; problems: GuideProblem[]; total: number }

const refuse = (reason: string): GuideCsvResult => ({ ok: false, problems: [{ line: 1, reason }], total: 1 })

/** One line's fields, or why it cannot be split. */
function splitLine(line: string): { fields: string[] } | { reason: string } {
  const fields: string[] = []
  let i = 0
  for (;;) {
    if (line[i] === '"') {
      let value = ""
      i++
      for (;;) {
        if (i >= line.length) return { reason: "A quoted field is not closed on its line" }
        if (line[i] === '"') {
          if (line[i + 1] !== '"') break
          i++
        }
        value += line[i++]
      }
      i++ // the closing quote
      if (i < line.length && line[i] !== ",") return { reason: "A quote may only open and close a whole field" }
      fields.push(value)
    } else {
      const end = line.indexOf(",", i)
      const value = end < 0 ? line.slice(i) : line.slice(i, end)
      if (value.includes('"')) return { reason: "A quote may only open and close a whole field" }
      fields.push(value)
      i = end < 0 ? line.length : end
    }
    if (i >= line.length) return { fields }
    i++ // the comma
    if (i === line.length) {
      fields.push("")
      return { fields }
    }
  }
}

function text(name: string, raw: string, required: boolean, reasons: string[]): string {
  const value = raw.trim()
  if (CONTROL.test(raw)) reasons.push(`${name} contains a control character`)
  else if (FORMULA.test(value)) reasons.push(`${name} starts with =, +, - or @ (a spreadsheet formula is refused)`)
  else if (required && value === "") reasons.push(`${name} is required`)
  else if (value.length > MAX_TEXT) reasons.push(`${name} is longer than ${MAX_TEXT} characters`)
  return value
}

function cents(name: string, raw: string, reasons: string[]): number | null {
  if (!/^\d+$/.test(raw)) {
    reasons.push(`${name} must be a whole number of cents (digits only, no separators or decimals)`)
    return null
  }
  const value = Number(raw)
  if (value <= 0) reasons.push(`${name} must be more than 0`)
  else if (value > MAX_CENTS) reasons.push(`${name} must be at most ${MAX_CENTS}`)
  else return value
  return null
}

/** A row, or the reasons it is refused. */
function readRow(line: string, lineNumber: number): { row: GuideRow } | { reasons: string[] } {
  if (line === "") return { reasons: ["An empty line between rows"] }
  const split = splitLine(line)
  if ("reason" in split) return { reasons: [split.reason] }
  if (split.fields.length !== COLUMNS) return { reasons: [`Expected ${COLUMNS} columns, found ${split.fields.length}`] }
  const [rawMake, rawModel, rawYear, rawVariant, rawTrade, rawRetail] = split.fields
  const reasons: string[] = []
  const make = text("make", rawMake, true, reasons)
  const model = text("model", rawModel, true, reasons)
  const variant = text("variant", rawVariant, false, reasons)
  const year = /^\d{4}$/.test(rawYear) ? Number(rawYear) : NaN
  if (!(year >= 1950 && year <= 2100)) reasons.push("year must be a whole year from 1950 to 2100")
  const tradeCents = cents("trade_cents", rawTrade, reasons)
  const retailCents = cents("retail_cents", rawRetail, reasons)
  if (tradeCents !== null && retailCents !== null && tradeCents > retailCents) reasons.push("the trade value is above the retail value")
  if (reasons.length > 0 || tradeCents === null || retailCents === null) return { reasons }
  return { row: { lineNumber, make, model, year, variant, tradeCents, retailCents } }
}

/** The make, model, year and variant a row is unique by, case ignored (ValuationGuideRow_key). */
export const guideRowKey = (row: Pick<GuideRow, "make" | "model" | "year" | "variant">) =>
  [row.make.toLowerCase(), row.model.toLowerCase(), row.year, row.variant.toLowerCase()].join("\u0000")

export function parseGuideCsv(bytes: Uint8Array): GuideCsvResult {
  let content: string
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return refuse("The file is not UTF-8 text")
  }
  const lines = content.replace(/^﻿/, "").split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  if (lines.length === 0) return refuse("The file is empty: it needs the header line and at least one row")
  if (lines[0] !== GUIDE_CSV_HEADER) return refuse(`The first line must be exactly: ${GUIDE_CSV_HEADER}`)
  if (lines.length === 1) return refuse("The file has a header but no rows")
  if (lines.length - 1 > MAX_GUIDE_ROWS) return refuse(`The file has more than ${MAX_GUIDE_ROWS} rows`)

  const rows: GuideRow[] = []
  const problems: GuideProblem[] = []
  const firstLine = new Map<string, number>()
  for (let i = 1; i < lines.length; i++) {
    const lineNumber = i + 1
    const read = readRow(lines[i], lineNumber)
    if ("reasons" in read) {
      problems.push({ line: lineNumber, reason: read.reasons.join("; ") })
      continue
    }
    const key = guideRowKey(read.row)
    const first = firstLine.get(key)
    if (first !== undefined) {
      problems.push({ line: lineNumber, reason: `duplicates line ${first} (same make, model, year and variant)` })
      continue
    }
    firstLine.set(key, lineNumber)
    rows.push(read.row)
  }
  if (problems.length > 0) return { ok: false, problems: problems.slice(0, MAX_SHOWN_PROBLEMS), total: problems.length }
  return { ok: true, rows }
}
