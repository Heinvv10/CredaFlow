import { recomputeLoanBalances, type ScheduleRowLike } from "@/lib/loan/balances"
import { recurringInstalmentDue } from "@/lib/loan/instalment"
import { sastCalendarDay } from "@/lib/loan/settlement"
import {
  deriveDobFromSaId,
  deriveGenderFromSaId,
  isValidSaIdNumber,
} from "@/lib/validation/client-wizard"
import {
  bureauAccountNumber,
  bureauDate,
  cleanAddressLine,
  cleanName,
  cleanPhone,
  cleanPostalCode,
  forenames,
  wholeRands,
} from "./clean"
import type { FieldValues, SubmissionKind } from "./layout"

// Pure mapping: one loan as at one date -> the field values of one bureau
// line. No database, no clock. ALL money in is CENTS; all money out is whole
// rands.

export type DataFlag = "D" | "R" | "C"
export type AdverseStatus = "W" | "L"
/** Statuses the ledger lets through once per loan. */
export const ONCE_ONLY_STATUSES = ["C", "T", "W", "L", "Z"] as const
/** Account closed and settled: every balance field must be zero. */
export const SETTLED_STATUSES = ["C", "T"] as const
/** Below this, a W or L is rejected by the bureau and must go as C (spec p41). */
export const ADVERSE_MINIMUM_RANDS = 100

export interface BureauLoanInput {
  kind: SubmissionKind
  dataFlag: DataFlag
  /** any instant on the SAST period / transaction date */
  asOf: Date
  supplierNumber: string
  loan: {
    reference: string
    status: string
    principal: number
    initiationFee: number
    startDate: Date
    maturityDate: Date
    closedAt: Date | null
    writeOffAt: Date | null
    collectionsStage: string
  }
  productType: string
  termDays: number
  initiationFeePayment: string
  loanPurposeCategory: string | null
  client: {
    idNumber: string
    firstName: string
    lastName: string
    dateOfBirth: Date | null
    addressLine1: string | null
    suburb: string | null
    city: string | null
    postalCode: string | null
    phone: string | null
    employerName: string | null
    monthlyIncome: number
    deceasedAt: Date | null
  }
  schedule: ScheduleRowLike[]
  /** capital + fees + interest to date + default charges, as at asOf */
  settlementCents: number
  /** default charges owed as at asOf (part of settlementCents) */
  chargesOutstandingCents: number
  lastPaymentDate: Date | null
  attorneyReferralDate: Date | null
  /** adverse statuses a staff member has confirmed consumer notice for */
  confirmedAdverse: AdverseStatus[]
  /** once-only statuses already sent for this loan in a LIVE monthly file */
  alreadySent: string[]
}

export interface MappedRecord {
  fields: FieldValues
  statusCode: string | null
  statusDate: Date | null
}

/**
 * MICRO -> M, PERSONAL -> P. ASSET_FINANCE -> P, unchanged from when asset
 * products were typed PERSONAL (whether an instalment sale needs its own
 * SACRRA account type is open). Anything else (PO funding) is not reported.
 */
export function bureauAccountType(productType: string): "M" | "P" | null {
  if (productType === "MICRO") return "M"
  if (productType === "PERSONAL" || productType === "ASSET_FINANCE") return "P"
  return null
}

const LOAN_REASON: Record<string, string> = {
  DEBT_CONSOLIDATION: "R",
  MEDICAL: "E",
  EDUCATION: "S",
  HOME_IMPROVEMENT: "H",
  VEHICLE: "F",
  BUSINESS: "J",
  FUNERAL: "D",
}

/**
 * Whole 30-day blocks of days in arrears (product rule): 0-29 -> 0,
 * 30-59 -> 1. Never more than the months the account has been open, never
 * above the two digits the field holds, and 0 when nothing is overdue.
 */
export function monthsInArrears(args: { daysInArrears: number; overdueRands: number; daysOpen: number }): number {
  if (args.overdueRands <= 0) return 0
  return Math.max(0, Math.min(Math.floor(args.daysInArrears / 30), Math.floor(args.daysOpen / 30), 99))
}

function resolveStatus(input: BureauLoanInput, balanceRands: number, overdueRands: number): { code: string | null; date: Date | null } {
  const { loan, client } = input
  // A registration never carries a status (p164); the closure is its own record.
  if (input.dataFlag === "R") return { code: null, date: null }
  if (loan.status === "COMPLETED") {
    const early = loan.closedAt !== null && sastCalendarDay(loan.closedAt) < sastCalendarDay(loan.maturityDate)
    return { code: early ? "T" : "C", date: loan.closedAt }
  }
  // Everything below is monthly-only (spec p41-44) and sent once.
  if (input.kind === "DAILY") return { code: null, date: null }
  // Collections stage, referral and death are read as they stand NOW. One
  // dated after the period is not this period's news: the loan is reported as
  // it stood, with no status, and the status goes in its own month's file.
  const afterPeriod = (date: Date | null) => date !== null && sastCalendarDay(date) > sastCalendarDay(input.asOf)
  const adverse = (code: AdverseStatus, date: Date | null) => {
    if (!input.confirmedAdverse.includes(code) || afterPeriod(date)) return null
    const small = balanceRands < ADVERSE_MINIMUM_RANDS && overdueRands < ADVERSE_MINIMUM_RANDS
    const sent = small ? "C" : code
    return input.alreadySent.includes(sent) ? null : { code: sent, date }
  }
  // Deceased outranks an adverse listing: a dead consumer is not listed as a defaulter.
  if (client.deceasedAt) {
    return input.alreadySent.includes("Z") || afterPeriod(client.deceasedAt)
      ? { code: null, date: null }
      : { code: "Z", date: client.deceasedAt }
  }
  if (loan.status === "WRITTEN_OFF") {
    const written = adverse("W", loan.writeOffAt)
    if (written) return written
  }
  if (loan.collectionsStage === "ATTORNEY_REFERRED") {
    const handed = adverse("L", input.attorneyReferralDate)
    if (handed) return handed
  }
  return { code: null, date: null }
}

export function mapLoan(input: BureauLoanInput): MappedRecord {
  const { loan, client } = input
  const accountType = bureauAccountType(input.productType)
  if (!accountType) throw new Error(`Product type ${input.productType} is not reported to the bureau`)

  const balances = recomputeLoanBalances(loan.principal, input.schedule, input.asOf)
  let balanceRands = wholeRands(input.settlementCents)
  let overdueRands = wholeRands(balances.arrearsAmount + input.chargesOutstandingCents)
  let instalmentRands = wholeRands(recurringInstalmentDue(input.schedule))
  const status = resolveStatus(input, balanceRands, overdueRands)

  // A write-off's overdue amount is the write-off value shown on the public record (p162).
  if (status.code === "W") overdueRands = balanceRands
  const settled = status.code === "C" || status.code === "T"
  if (settled) {
    balanceRands = 0
    overdueRands = 0
    instalmentRands = 0
  }
  const daysOpen = sastCalendarDay(input.asOf) - sastCalendarDay(loan.startDate)
  // No months in arrears on a daily record (p163).
  const arrearsMonths = settled || input.kind === "DAILY"
    ? 0
    : monthsInArrears({ daysInArrears: balances.daysInArrears, overdueRands, daysOpen })

  const idValid = isValidSaIdNumber(client.idNumber)
  const gender = idValid ? deriveGenderFromSaId(client.idNumber) : ""
  const dateOfBirth = client.dateOfBirth
    ? bureauDate(client.dateOfBirth)
    : deriveDobFromSaId(client.idNumber).replaceAll("-", "")
  const [forename1, forename2, forename3] = forenames(client.firstName)
  const incomeRands = wholeRands(client.monthlyIncome)
  // The fee is part of the debt only when it is collected through the schedule.
  const openingCents = loan.principal + (input.initiationFeePayment === "DEFERRED" ? loan.initiationFee : 0)

  const fields: FieldValues = {
    dataFlag: input.dataFlag,
    saIdNumber: /^\d{1,13}$/.test(client.idNumber) ? client.idNumber : "",
    gender: gender === "MALE" ? "M" : gender === "FEMALE" ? "F" : "",
    dateOfBirth,
    accountNumber: bureauAccountNumber(loan.reference),
    surname: cleanName(client.lastName),
    forename1,
    forename2,
    forename3,
    addressLine1: cleanAddressLine(client.addressLine1),
    addressLine2: cleanAddressLine(client.suburb),
    addressLine3: cleanAddressLine(client.city),
    postalCode: cleanPostalCode(client.postalCode),
    ownershipType: "00",
    loanReason: LOAN_REASON[input.loanPurposeCategory ?? ""] ?? "O",
    paymentType: "00",
    accountType,
    dateOpened: bureauDate(loan.startDate),
    // A registration carries no last payment date (p161).
    lastPaymentDate: input.dataFlag === "R" ? "" : bureauDate(input.lastPaymentDate),
    openingBalance: String(wholeRands(openingCents)),
    currentBalance: String(balanceRands),
    currentBalanceIndicator: "D",
    amountOverdue: String(overdueRands),
    instalment: String(instalmentRands),
    monthsInArrears: String(arrearsMonths),
    statusCode: status.code ?? "",
    repaymentFrequency: "03",
    terms: String(accountType === "M" ? 1 : Math.max(1, Math.round(input.termDays / 30))),
    statusDate: status.code ? bureauDate(status.date) : "",
    cellPhone: cleanPhone(client.phone),
    employer: cleanAddressLine(client.employerName),
    income: incomeRands > 0 ? String(incomeRands) : "",
    incomeFrequency: incomeRands > 0 ? "M" : "",
  }
  if (input.kind === "DAILY") {
    fields.supplierNumber = input.supplierNumber
    fields.transactionDate = bureauDate(input.asOf)
  }
  return { fields, statusCode: status.code, statusDate: status.code ? status.date : null }
}
