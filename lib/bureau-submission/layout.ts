// SACRRA Layout 700v2 (v2.8, June 2015): the ONE field table that both renders
// and parses a line. Positions are 1-based and inclusive, as the spec prints
// them (monthly p23-24, daily p26-27, header p22, trailer p24).

export type FieldKind = "alpha" | "numeric" | "date"
export type Justify = "left" | "right"
export type SubmissionKind = "DAILY" | "MONTHLY"
export type SubmissionMode = "TEST" | "LIVE"

export interface FieldSpec {
  name: string
  start: number
  end: number
  kind: FieldKind
  justify: Justify
}

/** Every field value is a string; the renderer pads, it never formats. */
export type FieldValues = Record<string, string>

export const MONTHLY_LENGTH = 700
export const DAILY_LENGTH = 718
export const CRLF = "\r\n"
export const LAYOUT_VERSION = "06"
/**
 * The spec's trailer count is N9, zero-filled (p24). Experian's own sample
 * prints `T18` unpadded. OPEN QUESTION for Experian — change it here only.
 */
export const TRAILER_COUNT_WIDTH = 9

const a = (name: string, start: number, end: number): FieldSpec =>
  ({ name, start, end, kind: "alpha", justify: "left" })
/** Alpha by format but right-aligned by exception (spec p158, p34, p36). */
const ar = (name: string, start: number, end: number): FieldSpec =>
  ({ name, start, end, kind: "alpha", justify: "right" })
const n = (name: string, start: number, end: number): FieldSpec =>
  ({ name, start, end, kind: "numeric", justify: "right" })
const d = (name: string, start: number, end: number): FieldSpec =>
  ({ name, start, end, kind: "date", justify: "right" })

export const MONTHLY_FIELDS: FieldSpec[] = [
  a("dataFlag", 1, 1),
  n("saIdNumber", 2, 14),
  a("nonSaIdNumber", 15, 30),
  a("gender", 31, 31),
  d("dateOfBirth", 32, 39),
  ar("branchCode", 40, 47),
  ar("accountNumber", 48, 72),
  ar("subAccountNumber", 73, 76),
  a("surname", 77, 101),
  a("title", 102, 106),
  a("forename1", 107, 120),
  a("forename2", 121, 134),
  a("forename3", 135, 148),
  a("addressLine1", 149, 173),
  a("addressLine2", 174, 198),
  a("addressLine3", 199, 223),
  a("addressLine4", 224, 248),
  ar("postalCode", 249, 254),
  a("ownerTenant", 255, 255),
  a("postalAddressLine1", 256, 280),
  a("postalAddressLine2", 281, 305),
  a("postalAddressLine3", 306, 330),
  a("postalAddressLine4", 331, 355),
  ar("postalAddressCode", 356, 361),
  a("ownershipType", 362, 363),
  a("loanReason", 364, 365),
  a("paymentType", 366, 367),
  a("accountType", 368, 369),
  d("dateOpened", 370, 377),
  d("deferredPaymentDate", 378, 385),
  d("lastPaymentDate", 386, 393),
  n("openingBalance", 394, 402),
  n("currentBalance", 403, 411),
  a("currentBalanceIndicator", 412, 412),
  n("amountOverdue", 413, 421),
  n("instalment", 422, 430),
  n("monthsInArrears", 431, 432),
  a("statusCode", 433, 434),
  n("repaymentFrequency", 435, 436),
  n("terms", 437, 440),
  d("statusDate", 441, 448),
  ar("oldBranchCode", 449, 456),
  ar("oldAccountNumber", 457, 481),
  ar("oldSubAccountNumber", 482, 485),
  ar("oldSupplierNumber", 486, 495),
  ar("homePhone", 496, 511),
  ar("cellPhone", 512, 527),
  ar("workPhone", 528, 543),
  a("employer", 544, 603),
  n("income", 604, 612),
  a("incomeFrequency", 613, 613),
  a("occupation", 614, 633),
  a("thirdPartyName", 634, 693),
  n("accountSoldToThirdParty", 694, 695),
  n("jointParticipants", 696, 698),
  a("filler", 699, 700),
]

/**
 * Experian's "Layout Fields_Daily" sheet lists these as 699-704, 705-711 and
 * 712-718. The spec (p27) and Experian's own sample file agree on the
 * positions below; the sheet is wrong.
 */
export const DAILY_TAIL: FieldSpec[] = [
  ar("supplierNumber", 701, 710),
  d("transactionDate", 711, 718),
]

export const DAILY_FIELDS: FieldSpec[] = [...MONTHLY_FIELDS, ...DAILY_TAIL]

export const HEADER_FIELDS: FieldSpec[] = [
  a("recordType", 1, 1),
  ar("supplierNumber", 2, 11),
  d("monthEndDate", 12, 19),
  n("version", 20, 21),
  d("creationDate", 22, 29),
  a("tradingName", 30, 89),
]

/**
 * Fields that are part of the bureau's match key or are identifiers: cutting
 * one short changes WHICH account or person the line is about, so an overflow
 * throws instead of truncating. Free text (names, address, employer) is cut.
 */
const NEVER_TRUNCATE = new Set([
  "accountNumber", "subAccountNumber", "branchCode", "supplierNumber",
  "oldAccountNumber", "oldSubAccountNumber", "oldBranchCode", "oldSupplierNumber",
  "nonSaIdNumber", "postalCode", "postalAddressCode", "homePhone", "cellPhone", "workPhone",
])

function renderField(field: FieldSpec, raw: string | undefined): string {
  const width = field.end - field.start + 1
  const value = (raw ?? "").trim()
  if (field.kind === "alpha") {
    const upper = value.toUpperCase()
    if (upper.length > width) {
      if (NEVER_TRUNCATE.has(field.name)) throw new Error(`Bureau field ${field.name} exceeds ${width} characters`)
      return upper.slice(0, width)
    }
    return field.justify === "right" ? upper.padStart(width, " ") : upper.padEnd(width, " ")
  }
  if (value === "") return "0".repeat(width)
  if (!/^\d+$/.test(value)) throw new Error(`Bureau field ${field.name} must be digits only`)
  if (field.kind === "date" && value.length !== width) throw new Error(`Bureau field ${field.name} must be CCYYMMDD`)
  if (value.length > width) throw new Error(`Bureau field ${field.name} exceeds ${width} digits`)
  return value.padStart(width, "0")
}

function renderLine(fields: FieldSpec[], values: FieldValues, length: number): string {
  const known = new Set(fields.map((field) => field.name))
  for (const name of Object.keys(values)) {
    if (!known.has(name)) throw new Error(`Bureau layout has no field ${name}`)
  }
  const line = fields.map((field) => renderField(field, values[field.name])).join("").padEnd(length, " ")
  if (line.length !== length) throw new Error(`Bureau line is ${line.length} characters, expected ${length}`)
  return line
}

function parseLine(fields: FieldSpec[], line: string): FieldValues {
  const values: FieldValues = {}
  for (const field of fields) {
    const slice = line.slice(field.start - 1, field.end)
    values[field.name] = field.kind === "alpha" ? slice.trim() : slice
  }
  return values
}

const fieldsFor = (kind: SubmissionKind) => (kind === "DAILY" ? DAILY_FIELDS : MONTHLY_FIELDS)
export const lineLength = (kind: SubmissionKind) => (kind === "DAILY" ? DAILY_LENGTH : MONTHLY_LENGTH)

export function renderRecord(values: FieldValues, kind: SubmissionKind): string {
  return renderLine(fieldsFor(kind), values, lineLength(kind))
}

/** Alpha fields come back trimmed; numeric and date fields as their digits. */
export function parseRecord(line: string, kind: SubmissionKind): FieldValues {
  return parseLine(fieldsFor(kind), line)
}

export function renderHeader(values: {
  supplierNumber: string
  monthEndDate: string
  creationDate: string
  tradingName: string
}): string {
  return renderLine(HEADER_FIELDS, { recordType: "H", version: LAYOUT_VERSION, ...values }, MONTHLY_LENGTH)
}

export function parseHeader(line: string): FieldValues {
  return parseLine(HEADER_FIELDS, line)
}

/** `lineCount` includes the header and the trailer themselves (spec p24). */
export function renderTrailer(lineCount: number): string {
  return `T${String(lineCount).padStart(TRAILER_COUNT_WIDTH, "0")}`.padEnd(MONTHLY_LENGTH, " ")
}

/** Reads the padded form and Experian's unpadded sample form alike. */
export function parseTrailer(line: string): { recordType: string; recordCount: number } {
  return { recordType: line.slice(0, 1), recordCount: Number(line.slice(1, 1 + TRAILER_COUNT_WIDTH).trim()) }
}

/** CRLF after every line, the last included. */
export function renderFile(lines: string[]): string {
  return lines.map((line) => line + CRLF).join("")
}

/** `<supplier>_ALL_<T702|L702>_<D|M>_<CCYYMMDD>_1_<seq>` (spec p19-20). */
export function bureauFileName(args: {
  supplierNumber: string
  mode: SubmissionMode
  kind: SubmissionKind
  date: string
  sequence: number
}): string {
  const fileType = args.mode === "LIVE" ? "L702" : "T702"
  const frequency = args.kind === "DAILY" ? "D" : "M"
  return `${args.supplierNumber.trim().toUpperCase()}_ALL_${fileType}_${frequency}_${args.date}_1_${args.sequence}`
}
