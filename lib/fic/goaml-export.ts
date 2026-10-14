/**
 * CTR and STR register exports for MANUAL upload to the FIC's goAML portal.
 *
 * "goAML-ready draft": NOT validated against, or claimed to conform to, the
 * goAML XML schema — that schema is not in this repository. The structure is
 * CredaFlow's own, built to carry the fields a compliance officer needs to
 * key or map the report. Every export says so in its content.
 */

export const GOAML_DRAFT_LABEL = "goAML-ready draft"
export const GOAML_DRAFT_NOTICE =
  "goAML-ready draft. Not validated against the goAML XML schema. Review every field before manual upload to goAML."

export type CtrExportRow = {
  paymentId: string
  receivedAt: Date
  amountCents: number
  loanReference: string
  clientReference: string
  clientName: string
  clientIdNumber: string
  filingStatus: "UNFILED" | "FILED" | "NOT_REPORTABLE"
  fiuReference: string | null
}

export type StrExportRow = {
  reference: string
  kind: string
  status: string
  raisedAt: Date
  clientReference: string | null
  clientName: string | null
  clientIdNumber: string | null
  loanReference: string | null
  paymentAmountCents: number | null
  paymentDate: Date | null
  grounds: string
  assessmentNote: string | null
  fiuReference: string | null
  reportedAt: Date | null
}

type Cell = string | number | Date | null

const rand = (cents: number | null) => (cents === null ? null : (cents / 100).toFixed(2))
const iso = (d: Date | null) => (d ? d.toISOString() : null)

/** RFC 4180 quoting, plus a leading apostrophe on anything a spreadsheet would run as a formula. */
export function csvCell(value: Cell): string {
  const text = value === null ? "" : value instanceof Date ? value.toISOString() : String(value)
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // XML 1.0 forbids most control characters outright.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
}

function ctrFields(r: CtrExportRow): Array<[string, Cell]> {
  return [
    ["reportType", "CTR"],
    ["internalReference", r.paymentId],
    ["transactionDate", iso(r.receivedAt)],
    ["amountZar", rand(r.amountCents)],
    ["currency", "ZAR"],
    ["transactionMethod", "CASH"],
    ["loanReference", r.loanReference],
    ["clientReference", r.clientReference],
    ["clientName", r.clientName],
    ["clientIdNumber", r.clientIdNumber],
    ["filingStatus", r.filingStatus],
    ["fiuReference", r.fiuReference],
  ]
}

function strFields(r: StrExportRow): Array<[string, Cell]> {
  return [
    ["reportType", "STR"],
    ["internalReference", r.reference],
    ["kind", r.kind],
    ["caseStatus", r.status],
    ["raisedAt", iso(r.raisedAt)],
    ["clientReference", r.clientReference],
    ["clientName", r.clientName],
    ["clientIdNumber", r.clientIdNumber],
    ["loanReference", r.loanReference],
    ["transactionAmountZar", rand(r.paymentAmountCents)],
    ["transactionDate", iso(r.paymentDate)],
    ["groundsForSuspicion", r.grounds],
    ["assessmentNote", r.assessmentNote],
    ["fiuReference", r.fiuReference],
    ["reportedAt", iso(r.reportedAt)],
  ]
}

function toCsv(rows: Array<Array<[string, Cell]>>, header: string[]): string {
  const head = ["exportStatus", ...header].map(csvCell).join(",")
  const body = rows.map((fields) => [csvCell(GOAML_DRAFT_LABEL), ...fields.map(([, v]) => csvCell(v))].join(","))
  return [head, ...body].join("\r\n") + "\r\n"
}

function toXml(register: "CTR" | "STR", rows: Array<Array<[string, Cell]>>, generatedAt: Date): string {
  const reports = rows.map((fields) => [
    "  <report>",
    ...fields.map(([k, v]) => {
      const text = v === null ? "" : v instanceof Date ? v.toISOString() : String(v)
      return `    <${k}>${xmlEscape(text)}</${k}>`
    }),
    "  </report>",
  ].join("\n"))
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- ${GOAML_DRAFT_NOTICE} -->`,
    `<ficRegisterExport register="${register}" status="${GOAML_DRAFT_LABEL}" generatedAt="${generatedAt.toISOString()}">`,
    ...reports,
    "</ficRegisterExport>",
    "",
  ].join("\n")
}

const CTR_HEADER = ctrFields({
  paymentId: "", receivedAt: new Date(0), amountCents: 0, loanReference: "", clientReference: "",
  clientName: "", clientIdNumber: "", filingStatus: "UNFILED", fiuReference: null,
}).map(([k]) => k)
const STR_HEADER = strFields({
  reference: "", kind: "", status: "", raisedAt: new Date(0), clientReference: null, clientName: null,
  clientIdNumber: null, loanReference: null, paymentAmountCents: null, paymentDate: null, grounds: "",
  assessmentNote: null, fiuReference: null, reportedAt: null,
}).map(([k]) => k)

export function buildCtrExport(rows: CtrExportRow[], format: "csv" | "xml", generatedAt: Date): string {
  const fields = rows.map(ctrFields)
  return format === "csv" ? toCsv(fields, CTR_HEADER) : toXml("CTR", fields, generatedAt)
}

export function buildStrExport(rows: StrExportRow[], format: "csv" | "xml", generatedAt: Date): string {
  const fields = rows.map(strFields)
  return format === "csv" ? toCsv(fields, STR_HEADER) : toXml("STR", fields, generatedAt)
}
