import { isValidSaIdNumber } from "@/lib/validation/client-wizard"
import { isValidAccountNumber } from "./clean"
import {
  parseRecord,
  parseTrailer,
  renderRecord,
  lineLength,
  type FieldValues,
  type SubmissionKind,
} from "./layout"
import { SETTLED_STATUSES } from "./map-loan"

// Two tiers. A RECORD rule holds that one loan back and the
// rest of the file goes. A FILE rule means the file itself is malformed and
// nothing is generated at all.

export const HOLD_REASONS = [
  "INVALID_SA_ID",
  "INVALID_SURNAME",
  "MISSING_FORENAME",
  "INVALID_ACCOUNT_NUMBER",
  "ARREARS_WITHOUT_OVERDUE",
  "CLOSURE_WITH_BALANCE",
  "ZERO_OPENING_BALANCE",
  "BALANCE_WITHOUT_INSTALMENT",
  "STATUS_WITHOUT_DATE",
  "ADVERSE_WITHOUT_ARREARS",
  "REGISTRATION_WITH_STATUS",
  "REGISTRATION_IN_CREDIT",
  "REGISTRATION_WITH_LAST_PAYMENT",
  // raised while preparing the file, not by a field rule
  "UNRENDERABLE",
  "DUPLICATE_ACCOUNT_NUMBER",
  "POST_PERIOD_ACTIVITY",
  "CHARGES_SWITCHED_AFTER_PERIOD",
  "REOPENED_AFTER_CLOSURE",
  "CANCELLED_AFTER_REGISTRATION",
] as const
export type HoldReason = (typeof HOLD_REASONS)[number]

const amount = (value: string | undefined) => Number(value || "0")
const isZeroDate = (value: string | undefined) => !value || /^0+$/.test(value)

/** Every record rule the mapped fields break. Empty means the record may go. */
export function validateRecord(fields: FieldValues): HoldReason[] {
  const reasons: HoldReason[] = []
  const status = fields.statusCode ?? ""

  if (!isValidSaIdNumber(fields.saIdNumber ?? "")) reasons.push("INVALID_SA_ID")
  // At least two characters, one a vowel; Y counts (spec p33).
  const surname = fields.surname ?? ""
  if (surname.replace(/[^A-Z]/g, "").length < 2 || !/[AEIOUY]/.test(surname)) reasons.push("INVALID_SURNAME")
  if (!(fields.forename1 ?? "")) reasons.push("MISSING_FORENAME")
  if (!isValidAccountNumber(fields.accountNumber ?? "")) reasons.push("INVALID_ACCOUNT_NUMBER")

  if (amount(fields.monthsInArrears) > 0 && amount(fields.amountOverdue) === 0) reasons.push("ARREARS_WITHOUT_OVERDUE")
  if (
    (SETTLED_STATUSES as readonly string[]).includes(status)
    && (amount(fields.currentBalance) !== 0 || amount(fields.amountOverdue) !== 0 || amount(fields.instalment) !== 0)
  ) reasons.push("CLOSURE_WITH_BALANCE")
  if (amount(fields.openingBalance) === 0) reasons.push("ZERO_OPENING_BALANCE")
  if (amount(fields.currentBalance) > 0 && amount(fields.instalment) === 0) reasons.push("BALANCE_WITHOUT_INSTALMENT")
  if (status && isZeroDate(fields.statusDate)) reasons.push("STATUS_WITHOUT_DATE")
  // W and L must carry an overdue amount and months in arrears (p163).
  if ((status === "W" || status === "L") && (amount(fields.amountOverdue) === 0 || amount(fields.monthsInArrears) === 0)) {
    reasons.push("ADVERSE_WITHOUT_ARREARS")
  }

  if (fields.dataFlag === "R") {
    if (status) reasons.push("REGISTRATION_WITH_STATUS")
    if (fields.currentBalanceIndicator === "C") reasons.push("REGISTRATION_IN_CREDIT")
    if (!isZeroDate(fields.lastPaymentDate)) reasons.push("REGISTRATION_WITH_LAST_PAYMENT")
  }
  return reasons
}

/**
 * Record rules, plus the one thing they cannot see: whether the line can be
 * rendered at all. A value too wide for its field would otherwise throw while
 * the file is assembled and take every other loan's line down with it.
 */
export function recordHolds(fields: FieldValues, kind: SubmissionKind): HoldReason[] {
  const reasons = validateRecord(fields)
  if (!reasons.includes("INVALID_ACCOUNT_NUMBER")) {
    try {
      renderRecord(fields, kind)
    } catch {
      reasons.push("UNRENDERABLE")
    }
  }
  return reasons
}

export const FILE_ERRORS = [
  "MISSING_SUPPLIER_NUMBER",
  "NON_PRINTABLE_CHARACTER",
  "WRONG_LINE_LENGTH",
  "TRAILER_COUNT_MISMATCH",
  "MISSING_HEADER_OR_TRAILER",
  "HEADER_ON_DAILY_FILE",
  "DUPLICATE_ACCOUNT_NUMBER",
] as const
export type FileError = (typeof FILE_ERRORS)[number]

/**
 * An error this module raised on purpose. Its message names a rule or a
 * period, never a person, so it is the ONLY kind of error message that may be
 * shown to a caller or returned by a cron.
 */
export class BureauError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BureauError"
  }
}

export class BureauFileError extends BureauError {
  constructor(readonly errors: FileError[]) {
    super(`Bureau file failed structural validation: ${errors.join(", ")}`)
    this.name = "BureauFileError"
  }
}

/** Every structural rule the rendered lines break. Empty means the file may be written. */
export function validateFile(kind: SubmissionKind, lines: string[], supplierNumber: string | null | undefined): FileError[] {
  const errors = new Set<FileError>()
  if (!supplierNumber?.trim()) errors.add("MISSING_SUPPLIER_NUMBER")
  const expected = lineLength(kind)
  if (lines.some((line) => line.length !== expected)) errors.add("WRONG_LINE_LENGTH")
  // Printable ASCII only (spec p22). A CR or LF inside a "line" is a second
  // physical line: a forged record, header or trailer.
  if (lines.some((line) => /[^\x20-\x7E]/.test(line))) errors.add("NON_PRINTABLE_CHARACTER")

  let records = lines
  if (kind === "MONTHLY") {
    const header = lines[0]
    const trailer = lines[lines.length - 1]
    if (lines.length < 2 || !header.startsWith("H") || !trailer.startsWith("T")) {
      errors.add("MISSING_HEADER_OR_TRAILER")
    } else {
      if (parseTrailer(trailer).recordCount !== lines.length) errors.add("TRAILER_COUNT_MISMATCH")
      records = lines.slice(1, -1)
    }
  } else if (lines.some((line) => line.startsWith("H") || line.startsWith("T"))) {
    // "The provision of a header in the daily file will result in a full file rejection" (p26).
    errors.add("HEADER_ON_DAILY_FILE")
  }

  // One line per account per data flag: a daily file may register and close
  // the same account, but nothing may appear twice under one flag.
  const seen = new Set<string>()
  for (const line of records) {
    if (line.length !== expected) continue
    const parsed = parseRecord(line, kind)
    const key = `${parsed.dataFlag}|${parsed.accountNumber}`
    if (seen.has(key)) errors.add("DUPLICATE_ACCOUNT_NUMBER")
    seen.add(key)
  }
  return [...errors]
}
