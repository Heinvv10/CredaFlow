import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { Problems, isDay, isObject, rejectUnknownKeys } from "@/lib/decisioning/validate-common"
import { LOAN_CHANGE_TYPES, type LoanChangePayload, type LoanChangeType } from "./types"

const MAX_INSTALMENTS = 520
const MAX_HOLIDAY = 24
const MAX_CONSOLIDATED = 10

const COMMON = ["type", "loanId", "reason", "signedDocumentId"] as const
const FIELDS: Record<LoanChangeType, readonly string[]> = {
  RESCHEDULE: ["firstDueDate"],
  RESTRUCTURE: ["interestRatePm", "instalments"],
  PAYMENT_HOLIDAY: ["holidayInstalments"],
  RATE_CHANGE: ["interestRatePm"],
  TERM_CHANGE: ["instalments"],
  TOP_UP: ["newMoneyCents", "payoutReference", "instalments", "interestRatePm"],
  REFINANCE: ["instalments", "interestRatePm"],
  CONSOLIDATION: ["otherLoanIds", "instalments", "interestRatePm"],
}
/** Fields a type cannot do without; the rest of FIELDS is optional. */
const REQUIRED: Record<LoanChangeType, readonly string[]> = {
  RESCHEDULE: ["firstDueDate"], RESTRUCTURE: [], PAYMENT_HOLIDAY: ["holidayInstalments"], RATE_CHANGE: ["interestRatePm"], TERM_CHANGE: ["instalments"],
  TOP_UP: ["newMoneyCents", "payoutReference", "instalments"], REFINANCE: ["instalments"], CONSOLIDATION: ["otherLoanIds", "instalments"],
}

const isText = (value: unknown, min: number, max: number) => typeof value === "string" && value.trim().length >= min && value.length <= max
const isWhole = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max

function checkField(key: string, value: unknown, problems: Problems, loanId: unknown): void {
  const at = `payload.${key}`
  if (key === "firstDueDate" && !isDay(value)) problems.add(at, "a date, YYYY-MM-DD")
  if (key === "interestRatePm" && !(typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1)) problems.add(at, "a monthly rate as a decimal, 0 or more and below 1")
  if (key === "instalments" && !isWhole(value, 1, MAX_INSTALMENTS)) problems.add(at, `a whole number from 1 to ${MAX_INSTALMENTS}`)
  if (key === "holidayInstalments" && !isWhole(value, 1, MAX_HOLIDAY)) problems.add(at, `a whole number from 1 to ${MAX_HOLIDAY}`)
  if (key === "newMoneyCents" && !isWhole(value, 1, 2_000_000_000)) problems.add(at, "a positive amount in cents")
  if (key === "payoutReference" && !isText(value, 3, 120)) problems.add(at, "3 to 120 characters: the reference of the transfer the new money goes out on")
  if (key === "otherLoanIds") {
    const ids = Array.isArray(value) ? value : []
    const valid = ids.length >= 1 && ids.length <= MAX_CONSOLIDATED && ids.every((id) => typeof id === "string" && id.length > 0 && id !== loanId) && new Set(ids).size === ids.length
    if (!valid) problems.add(at, `1 to ${MAX_CONSOLIDATED} other loans of this borrower, each once`)
  }
}

/** Pure. Accepts exactly the fields of the change's type and stores them trimmed. */
export function parseLoanChangePayload(raw: unknown): LoanChangePayload {
  if (!isObject(raw)) throw new InvalidPayloadError(["payload: expected an object"])
  const problems = new Problems()
  if (!(LOAN_CHANGE_TYPES as readonly unknown[]).includes(raw.type)) {
    problems.add("payload.type", `one of ${LOAN_CHANGE_TYPES.join(", ")}`)
    problems.throwIfAny()
  }
  const type = raw.type as LoanChangeType
  const allowed = FIELDS[type]
  rejectUnknownKeys(raw, [...COMMON, ...allowed], "payload", problems)
  if (!isText(raw.loanId, 1, 100)) problems.add("payload.loanId", "the loan this change is for")
  if (!isText(raw.reason, 5, 500)) problems.add("payload.reason", "5 to 500 characters: why the loan changes")
  if (!isText(raw.signedDocumentId, 1, 100)) problems.add("payload.signedDocumentId", "the borrower's signed variation or agreement, from their documents")
  for (const key of REQUIRED[type]) if (raw[key] === undefined) problems.add(`payload.${key}`, "required")
  for (const key of allowed) if (raw[key] !== undefined) checkField(key, raw[key], problems, raw.loanId)
  if (type === "RESTRUCTURE" && raw.interestRatePm === undefined && raw.instalments === undefined) problems.add("payload", "a restructure changes the rate, the term or both")
  problems.throwIfAny()
  const parsed: Record<string, unknown> = { type, loanId: (raw.loanId as string).trim(), reason: (raw.reason as string).trim(), signedDocumentId: (raw.signedDocumentId as string).trim() }
  for (const key of allowed) if (raw[key] !== undefined) parsed[key] = typeof raw[key] === "string" ? (raw[key] as string).trim() : raw[key]
  return parsed as unknown as LoanChangePayload
}
