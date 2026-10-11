import type {
  ClientWizardData,
  ClientWizardStep,
  DebtObligationInput,
  ExpenseBreakdownInputs,
} from "@/components/clients/wizard/types"
import { minimumLivingExpense } from "@/lib/affordability/mle"
import { sumExpenseBreakdown } from "@/lib/affordability/sum-expense-breakdown"
import {
  DEBT_ACCOUNT_TYPE_VALUES,
  normaliseDebtAccountType,
} from "@/lib/credit/debt-account-types"
import { sastParts } from "@/lib/date/sast"

export type ValidationErrors<T> = Partial<Record<keyof T, string>>

export type ExpenseBreakdownErrors = Partial<Record<keyof ExpenseBreakdownInputs, string>>
export type DebtObligationErrors = Partial<Record<keyof DebtObligationInput, string>>

// Nested-aware error shape for the client wizard. The two new Step-3 fields
// (`expenseBreakdown` + `debtObligations`) are structured, so their errors
// are too. Other fields keep the flat `string` shape.
export type ClientWizardErrors = Partial<
  Omit<Record<keyof ClientWizardData, string>, "expenseBreakdown" | "debtObligations">
> & {
  expenseBreakdown?: ExpenseBreakdownErrors
  debtObligations?: DebtObligationErrors[]
}

function hasAnyError(obj: Record<string, string | undefined> | undefined): boolean {
  if (!obj) return false
  for (const key in obj) if (obj[key]) return true
  return false
}

// Maps a server-side errors map to the earliest wizard step that contains
// any flagged field. Used to "rewind" the user to the failing step after
// a server 400.
const STEP_FIELDS: Record<ClientWizardStep, (keyof ClientWizardData)[]> = {
  1: [
    "firstName", "lastName", "idNumber", "dateOfBirth",
    "gender", "email", "phone", "whatsapp",
  ],
  2: ["addressLine1", "suburb", "city", "province", "postalCode"],
  3: [
    "employmentStatus", "incomeSourceType", "employerName", "employerAddress",
    "employmentStartDate", "salaryPaymentDay", "monthlyIncome", "grossMonthlyIncome",
    "bankName", "bankAccountNumber", "bankBranchCode", "accountType",
    "nextOfKinName", "nextOfKinPhone", "nextOfKinRelationship",
  ],
  4: ["popiaConsentGiven"],
}

export function earliestStepWithErrors(errs: ClientWizardErrors): ClientWizardStep {
  const steps: ClientWizardStep[] = [1, 2, 3, 4]
  for (const s of steps) {
    if (STEP_FIELDS[s].some((f) => (errs as Record<string, unknown>)[f])) return s
    if (s === 3) {
      if (hasAnyError(errs.expenseBreakdown)) return s
      if (errs.debtObligations?.some((rowErrs) => hasAnyError(rowErrs))) return s
    }
  }
  // No mapped fields matched — fall through to the review step so the user at
  // least sees the generic error banner without an unrelated earlier step
  // blocking them.
  return 4
}

// --- SA-specific helpers ---

function luhnCheck(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i])
    if (alt) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

export function isValidSaIdNumber(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false
  const month = Number(id.slice(2, 4))
  const day = Number(id.slice(4, 6))
  if (month < 1 || month > 12) return false
  if (day < 1 || day > 31) return false
  // SA ID Luhn check on all 13 digits
  return luhnCheck(id)
}

export function deriveDobFromSaId(id: string): string {
  if (!isValidSaIdNumber(id)) return ""
  const yy = Number(id.slice(0, 2))
  const mm = id.slice(2, 4)
  const dd = id.slice(4, 6)
  // SA convention: YY <= current 2-digit year => 2000s; otherwise 1900s.
  // Cutoff is dynamic — a static cutoff (e.g. "24") incorrectly classes
  // newborns as 19xx once the year rolls past it.
  // SAST year. This runs on the server, where the container is UTC. It is not
  // safe to exempt on the reasoning that the two-hour band "can only straddle
  // 1 January, where both readings yield the same century": at 00:30 SAST on
  // 1 Jan 2027 the UTC year is still 2026, so `currentYY` is 26 and an ID with `yy = 27` fails `yy <= currentYY` and is read as 1927
  // instead of 2027. A newborn dependant on a funeral policy is exactly the
  // case that produces such an ID.
  const currentYY = sastParts(new Date()).year % 100
  const yearPrefix = yy <= currentYY ? "20" : "19"
  return `${yearPrefix}${id.slice(0, 2)}-${mm}-${dd}`
}

/**
 * Derive gender from positions 7–10 of a 13-digit SA-ID.
 *
 * SA-ID encoding: digits 7–10 (indices 6–9, 0-based) are the gender
 * sequence number. 0000–4999 = female, 5000–9999 = male.
 *
 * Returns "" for inputs shorter than 13 digits or where positions 7–10
 * are not all numeric. Does NOT validate the Luhn checksum — that is
 * the caller's responsibility (see `isValidSaIdNumber`).
 */
export function deriveGenderFromSaId(id: string): "MALE" | "FEMALE" | "" {
  if (id.length !== 13) return ""
  const sequence = id.slice(6, 10)
  if (!/^\d{4}$/.test(sequence)) return ""
  return Number(sequence) < 5000 ? "FEMALE" : "MALE"
}

export function isValidSaPhone(p: string): boolean {
  if (/^\+27[6-8]\d{8}$/.test(p)) return true
  if (/^0[6-8]\d{8}$/.test(p)) return true
  return false
}

// --- Step 1 Identity ---

export function validateStep1Identity(
  d: ClientWizardData,
): ClientWizardErrors {
  const errs: ClientWizardErrors = {}

  if (!d.firstName.trim()) errs.firstName = "Required"
  if (!d.lastName.trim()) errs.lastName = "Required"

  if (!d.idNumber.trim()) {
    errs.idNumber = "Required"
  } else if (!isValidSaIdNumber(d.idNumber)) {
    errs.idNumber = "Not a valid 13-digit SA ID number"
  }

  if (!d.dateOfBirth) {
    errs.dateOfBirth = "Required"
  } else if (isValidSaIdNumber(d.idNumber)) {
    const derived = deriveDobFromSaId(d.idNumber)
    if (derived && derived !== d.dateOfBirth) {
      errs.dateOfBirth = "Does not match the ID number"
    }
  }

  if (!d.gender) errs.gender = "Required"

  if (!d.email.trim()) {
    errs.email = "Required"
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) {
    errs.email = "Not a valid email address"
  }

  if (!d.phone.trim()) {
    errs.phone = "Required"
  } else if (!isValidSaPhone(d.phone)) {
    errs.phone = "Use +27… or 0… mobile format"
  }

  // whatsapp optional — validate format only if provided
  if (d.whatsapp.trim() && !isValidSaPhone(d.whatsapp)) {
    errs.whatsapp = "Use +27… or 0… mobile format"
  }

  return errs
}

// --- Step 2 Address ---

const SA_PROVINCES = ["EC", "FS", "GP", "KZN", "LP", "MP", "NC", "NW", "WC"] as const

export function validateStep2Address(
  d: ClientWizardData,
): ClientWizardErrors {
  const errs: ClientWizardErrors = {}

  if (!d.suburb.trim()) errs.suburb = "Required"
  if (!d.city.trim()) errs.city = "Required"

  if (!d.province) {
    errs.province = "Required"
  } else if (!SA_PROVINCES.includes(d.province as (typeof SA_PROVINCES)[number])) {
    errs.province = "Use a SA province code (EC, FS, GP, KZN, LP, MP, NC, NW, WC)"
  }

  if (!d.postalCode.trim()) {
    errs.postalCode = "Required"
  } else if (!/^\d{4}$/.test(d.postalCode)) {
    errs.postalCode = "Use a 4-digit SA postal code"
  }

  return errs
}

// --- Step 3 Employment & income ---

// The Step 3 dropdowns. These live here rather than in the component because
// every `value` below is persisted straight onto a Prisma enum column
// (Client.employmentStatus / .incomeSourceType / .accountType). Keeping them
// runtime-pure lets client-wizard.test.ts assert each one against the
// generated @prisma/client enum — a value that is not an enum member reaches
// prisma.client.create() and throws PrismaClientValidationError, which is how
// a non-member option such as "Wages" would 500 client creation.
export const EMPLOYMENT_STATUSES = [
  { value: "EMPLOYED", label: "Employed (full-time)" },
  { value: "PART_TIME", label: "Part-time / contract" },
  { value: "SELF_EMPLOYED", label: "Self-employed" },
  { value: "UNEMPLOYED", label: "Unemployed" },
  { value: "STUDENT", label: "Student" },
  { value: "PENSIONER", label: "Retired / pensioner" },
]

export const INCOME_SOURCE_TYPES = [
  { value: "SALARY", label: "Salary" },
  { value: "WAGES", label: "Wages" },
  { value: "BUSINESS_INCOME", label: "Business income" },
  { value: "SOCIAL_GRANT", label: "Government grant" },
  { value: "RENTAL_INCOME", label: "Rental income" },
  { value: "PENSION", label: "Pension" },
  { value: "OTHER", label: "Other" },
]

/**
 * Account types a STAFF member may record against a client.
 *
 * "Other" is the audited escape hatch for a bank product name the statement
 * allow-lists have not learned — see `BankAccountType.OTHER` in
 * prisma/schema.prisma. It is offered here and NOT on the consumer portal: a
 * consumer self-selecting past a verification check is a different thing from a
 * staff member deciding, on the record, that a printed product name is neither
 * cheque nor savings.
 */
export const ACCOUNT_TYPES = [
  { value: "CHEQUE", label: "Cheque / current" },
  { value: "SAVINGS", label: "Savings" },
  { value: "OTHER", label: "Other" },
]

// Derived, never hand-listed: the server rejects exactly what the dropdown
// declines to offer, so the two cannot drift apart.
export const EMPLOYMENT_STATUS_VALUES = new Set(EMPLOYMENT_STATUSES.map((o) => o.value))
export const INCOME_SOURCE_TYPE_VALUES = new Set(INCOME_SOURCE_TYPES.map((o) => o.value))
export const ACCOUNT_TYPE_VALUES = new Set(ACCOUNT_TYPES.map((o) => o.value))

/**
 * The human label for a stored account type.
 *
 * Review screens rendered the raw enum, so a staff member checking a payout saw
 * the bare token "OTHER" with nothing to say what it meant for the statement
 * check. Falls back to the stored value, so a legacy TRANSMISSION row still
 * shows something rather than an empty cell.
 */
export function accountTypeLabel(value: string | null | undefined): string {
  if (!value) return ""
  return ACCOUNT_TYPES.find((o) => o.value === value)?.label ?? value
}

// Statuses that carry no employer, so Step 3 stops demanding employer name /
// address / start date / salary day. PENSIONER replaced the wizard-only
// "RETIRED" spelling; both meant the same thing, only PENSIONER persists.
export const UNEMPLOYED_STATUSES = new Set(["UNEMPLOYED", "STUDENT", "PENSIONER"])

const RAND_REGEX = /^\d+(\.\d{1,2})?$/

function randStringToCentsOrNull(v: string): number | null {
  if (!v.trim()) return null
  if (!RAND_REGEX.test(v)) return null
  return Math.round(parseFloat(v) * 100)
}

type ExpenseCategoryKey = Exclude<keyof ExpenseBreakdownInputs, "belowMleJustification">

const EXPENSE_FIELDS: ExpenseCategoryKey[] = [
  "housing", "transport", "food", "education", "insurance",
  "clothing", "entertainment", "medical", "other",
]

// Re-exported from the shared vocabulary rather than hand-copied. The copy
// that used to live here drifted: it never gained MICROFINANCE or
// CLOTHING_ACCOUNT, so two types the affordability panel could write were
// values this validator rejected.
export { DEBT_ACCOUNT_TYPE_VALUES }

export function validateStep3Employment(d: ClientWizardData): ClientWizardErrors {
  const errs: ClientWizardErrors = {}

  // Membership is checked, not just presence: these persist to Prisma enum
  // columns, where an unknown value throws rather than returning a field
  // error. Catching it here turns a 500 into a 400 the wizard can render.
  if (!d.employmentStatus) {
    errs.employmentStatus = "Required"
  } else if (!EMPLOYMENT_STATUS_VALUES.has(d.employmentStatus)) {
    errs.employmentStatus = "Unknown employment status"
  }
  if (!d.incomeSourceType) {
    errs.incomeSourceType = "Required"
  } else if (!INCOME_SOURCE_TYPE_VALUES.has(d.incomeSourceType)) {
    errs.incomeSourceType = "Unknown income source"
  }

  const isUnemployed = UNEMPLOYED_STATUSES.has(d.employmentStatus)
  if (!isUnemployed) {
    if (!d.employerName.trim()) errs.employerName = "Required"
    if (!d.employerAddress.trim()) errs.employerAddress = "Required"
    if (!d.employmentStartDate) errs.employmentStartDate = "Required"
    if (!d.salaryPaymentDay) {
      errs.salaryPaymentDay = "Required"
    } else {
      const day = Number(d.salaryPaymentDay)
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        errs.salaryPaymentDay = "Day of month between 1 and 31"
      }
    }
  }

  if (!d.monthlyIncome.trim()) {
    errs.monthlyIncome = "Required"
  } else if (!RAND_REGEX.test(d.monthlyIncome)) {
    errs.monthlyIncome = "Numeric amount in Rand"
  }

  if (d.grossMonthlyIncome.trim() && !RAND_REGEX.test(d.grossMonthlyIncome)) {
    errs.grossMonthlyIncome = "Numeric amount in Rand"
  }

  // --- Expense breakdown: 9 per-category fields + MLE gate ---
  const breakdownErrs: ExpenseBreakdownErrors = {}
  const breakdownCents: Record<ExpenseCategoryKey, number> = {
    housing: 0, transport: 0, food: 0, education: 0, insurance: 0,
    clothing: 0, entertainment: 0, medical: 0, other: 0,
  }
  for (const f of EXPENSE_FIELDS) {
    const raw = d.expenseBreakdown[f]
    if (!raw.trim()) continue // empty = 0, allowed
    if (!RAND_REGEX.test(raw)) {
      breakdownErrs[f] = "Numeric amount in Rand"
      continue
    }
    breakdownCents[f] = Math.round(parseFloat(raw) * 100)
  }
  const sumCents = sumExpenseBreakdown(breakdownCents)
  const grossCents = randStringToCentsOrNull(d.grossMonthlyIncome)
  if (grossCents !== null && grossCents > 0) {
    const floor = minimumLivingExpense(grossCents)
    if (sumCents < floor && !d.expenseBreakdown.belowMleJustification.trim()) {
      breakdownErrs.belowMleJustification =
        "Justification required when expenses are below the NCA Regulation 23A minimum"
    }
  }
  if (Object.keys(breakdownErrs).length > 0) errs.expenseBreakdown = breakdownErrs

  // --- Debt obligations: per-row all-or-nothing ---
  const debtErrs: DebtObligationErrors[] = d.debtObligations.map((row) => {
    const rowErrs: DebtObligationErrors = {}
    const anyFilled =
      row.creditProvider.trim() !== "" ||
      row.outstandingBalance.trim() !== "" ||
      row.monthlyInstalment.trim() !== ""
    if (!anyFilled) return rowErrs
    if (!row.creditProvider.trim()) rowErrs.creditProvider = "Required"
    // Test what the select DISPLAYS, not the raw column. A legacy value renders
    // a correct label via the normaliser, so validating the raw string would
    // reject a row that looks entirely valid on screen, with nothing to fix.
    if (row.accountType && !normaliseDebtAccountType(row.accountType)) {
      rowErrs.accountType = "Unknown account type"
    }
    if (!row.outstandingBalance.trim()) {
      rowErrs.outstandingBalance = "Required"
    } else if (!RAND_REGEX.test(row.outstandingBalance)) {
      rowErrs.outstandingBalance = "Numeric amount in Rand"
    }
    if (!row.monthlyInstalment.trim()) {
      rowErrs.monthlyInstalment = "Required"
    } else if (!RAND_REGEX.test(row.monthlyInstalment)) {
      rowErrs.monthlyInstalment = "Numeric amount in Rand"
    }
    return rowErrs
  })
  if (debtErrs.some(hasAnyError)) errs.debtObligations = debtErrs

  if (!d.bankName.trim()) errs.bankName = "Required"

  if (!d.bankAccountNumber.trim()) {
    errs.bankAccountNumber = "Required"
  } else if (!/^\d{6,16}$/.test(d.bankAccountNumber)) {
    errs.bankAccountNumber = "6–16 digit account number"
  }

  if (!d.bankBranchCode.trim()) {
    errs.bankBranchCode = "Required"
  } else if (!/^\d{6}$/.test(d.bankBranchCode)) {
    errs.bankBranchCode = "6-digit universal branch code"
  }

  if (!d.accountType) {
    errs.accountType = "Required"
  } else if (!ACCOUNT_TYPE_VALUES.has(d.accountType)) {
    errs.accountType = "Unknown account type"
  }

  if (!d.nextOfKinName.trim()) errs.nextOfKinName = "Required"
  if (!d.nextOfKinPhone.trim()) {
    errs.nextOfKinPhone = "Required"
  } else if (!isValidSaPhone(d.nextOfKinPhone)) {
    errs.nextOfKinPhone = "Use +27… or 0… mobile format"
  }
  if (!d.nextOfKinRelationship.trim()) errs.nextOfKinRelationship = "Required"

  return errs
}

// --- Step 4 Review (compliance) ---

export function validateStep4Review(d: ClientWizardData): ClientWizardErrors {
  const errs: ClientWizardErrors = {}

  // POPIA §11 — explicit consent must be captured before saving the client.
  // The checkbox lives in the Review step so the user confirms consent right
  // before the irreversible "Create client" action.
  if (d.popiaConsentGiven !== true) {
    errs.popiaConsentGiven = "Required"
  }

  return errs
}

// --- Cross-step (full-form) validation ---

export function validateAllClient(d: ClientWizardData): ClientWizardErrors {
  return {
    ...validateStep1Identity(d),
    ...validateStep2Address(d),
    ...validateStep3Employment(d),
    ...validateStep4Review(d),
  }
}
