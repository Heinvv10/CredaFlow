/**
 * CSV rendering for the NCR quarterly return.
 *
 * Extracted from the client component so it is reachable by a test: the
 * component uses hooks, so the plain-function render pattern used elsewhere in
 * this repo cannot exercise its export handler. The rand conversion, the
 * quoting and the auditor-facing footer are all silent-failure shaped — wrong
 * by a factor of 100, or missing a caveat, with nothing to notice it.
 */

import { ncrPositionBasis } from "./ncr-position-basis"
import type { NcrReturnData, NcrReturnLine } from "@/lib/compliance/ncr-return"

/** RFC 4180 quoting: wrap in quotes and double any embedded quote. */
export function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export const NCR_CSV_HEADER = "Description,Count,Value (ZAR),% of book,Basis,Note"

export function ncrBasisLabel(line: NcrReturnLine, asFiled: boolean): string {
  if (line.basis === "PERIOD") return "In-quarter"
  return asFiled ? "Position as filed" : "Position at export"
}

export function buildNcrCsv(options: {
  data: NcrReturnData
  quarterLabel: string
  generatedAt: Date
  formatDate: (d: Date | string) => string
  formatDateTime: (d: Date | string) => string
}): string {
  const { data, quarterLabel, generatedAt, formatDate, formatDateTime } = options

  // A submitted quarter exports what was FILED. `data.lines` has moved with the
  // live book since submission.
  const lines = data.filed?.lines ?? data.lines
  const asFiled = data.filed !== null

  const body = lines.map((l) => [
    csvEscape(l.label),
    l.count ?? "",
    // Money is stored in CENTS throughout the app; the CSV states rands.
    l.value === null ? "" : (l.value / 100).toFixed(2),
    l.percentOfBook === undefined ? "" : l.percentOfBook.toFixed(1),
    ncrBasisLabel(l, asFiled),
    // The note is the basis caveat. Without it an auditor reads a value and a
    // percentage that cannot be derived from each other.
    csvEscape(l.note ?? ""),
  ].join(","))

  const positionBasis = asFiled
    ? `Figures as filed${data.submittedAt ? ` on ${formatDate(data.submittedAt)}` : ""}`
    : ncrPositionBasis(data, false, formatDate)

  const footer = [
    "",
    `${csvEscape("NCR Registration Number")},${csvEscape(data.ncrNumber)}`,
    `${csvEscape("Quarter")},${csvEscape(quarterLabel)}`,
    `${csvEscape("Period")},${csvEscape(`${formatDate(data.periodStart)} - ${formatDate(data.periodEnd)}`)}`,
    `${csvEscape("Generated")},${csvEscape(formatDateTime(generatedAt))}`,
    `${csvEscape("Position basis")},${csvEscape(positionBasis)}`,
  ]

  return [NCR_CSV_HEADER, ...body, ...footer].join("\n")
}
