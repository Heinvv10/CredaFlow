/**
 * Demo-simulator personas: fictional South African borrowers.
 *
 * Every value here is synthetic. Money is CENTS (integers), the same
 * convention as the app (Client.monthlyIncome, ExistingDebtObligation, NDI).
 * Enum-like strings use the exact values the client wizard persists
 * (lib/validation/client-wizard.ts, lib/banks.ts, lib/credit/debt-account-types.ts)
 * so a scenario can post a persona straight to the API.
 */

/** Which lifecycle storyline the simulator should drive this persona into. */
export type Storyline =
  // Live-demo personas, driven by a presenter during the demo.
  | 'live-clean-approve'
  | 'live-affordability-decline'
  | 'live-returning-client'
  // Background: a loan that reached this servicing state.
  | 'settled'
  | 'active'
  | 'arrears-30'
  | 'arrears-60'
  | 'arrears-90'
  | 's129'
  | 'payment-plan'
  | 'written-off'
  // Background: an application that ended without a loan.
  | 'declined'
  | 'withdrawn'
  // Background: an application parked mid-origination.
  | 'origination-draft'
  | 'origination-submitted'
  | 'origination-under-review'
  | 'origination-approved'
  | 'origination-signed'

export type PersonaKind = 'live-demo' | 'background'

/** Bank codes as stored on Client.bankName (lib/banks.ts SA_BANKS). */
export type PersonaBankCode = 'ABSA' | 'FNB' | 'NEDBANK' | 'STANDARD_BANK' | 'CAPITEC' | 'TYME_BANK'

/** lib/credit/debt-account-types.ts DEBT_ACCOUNT_TYPES values. */
export type DebtAccountType =
  | 'HOME_LOAN'
  | 'VEHICLE_FINANCE'
  | 'PERSONAL_LOAN'
  | 'CREDIT_CARD'
  | 'STORE_ACCOUNT'
  | 'CLOTHING_ACCOUNT'
  | 'MICROFINANCE'

/** Province codes accepted by the client wizard. */
export type ProvinceCode = 'EC' | 'FS' | 'GP' | 'KZN' | 'LP' | 'MP' | 'NC' | 'NW' | 'WC'

export interface Address {
  addressLine1: string
  suburb: string
  city: string
  province: ProvinceCode
  postalCode: string
}

export interface Employment {
  employmentStatus: 'EMPLOYED'
  incomeSourceType: 'SALARY'
  employerName: string
  employerAddress: string
  occupation: string
  employeeNumber: string
  /** YYYY-MM-DD */
  employmentStartDate: string
  /** Day of month salary is paid (1–31; clamped to month length on documents). */
  salaryPaymentDay: number
}

/** One month's payslip figures. gross − totalDeductions === net, exactly. */
export interface Payroll {
  basicCents: number
  /** Travel/housing allowance; 0 when the persona has none. */
  allowanceCents: number
  grossCents: number
  payeCents: number
  uifCents: number
  pensionCents: number
  medicalAidCents: number
  totalDeductionsCents: number
  netCents: number
  taxReference: string
}

export interface BankAccount {
  bankCode: PersonaBankCode
  /** Universal branch code for the bank. */
  branchCode: string
  accountNumber: string
  accountType: 'CHEQUE' | 'SAVINGS'
}

/** Mirrors ExpenseBreakdownInputs, in cents. */
export interface ExpenseBreakdown {
  housing: number
  transport: number
  food: number
  education: number
  insurance: number
  clothing: number
  entertainment: number
  medical: number
  other: number
}

export interface DebtObligation {
  creditProvider: string
  accountType: DebtAccountType
  outstandingBalanceCents: number
  monthlyInstalmentCents: number
  /** Day of month the debit order runs. */
  debitDay: number
}

/** Seeded product codes (prisma/seed.ts). Term is in days, as LoanProduct is. */
export interface LoanRequest {
  productCode: 'PERSONAL' | 'MICRO30'
  amountCents: number
  termDays: number
}

export interface NextOfKin {
  name: string
  phone: string
  /** Free text on the client wizard. */
  relationship: 'Spouse' | 'Parent' | 'Sibling' | 'Friend'
}

export interface Persona {
  /** Stable slug: `live-…` for live-demo personas, `bg-NN` for background. */
  id: string
  /** 1-based, unique; also encoded in the ID number's sequence digits. */
  index: number
  kind: PersonaKind
  storyline: Storyline
  /** One line for the presenter's cheat sheet. */
  summary: string
  firstName: string
  lastName: string
  idNumber: string
  /** YYYY-MM-DD, consistent with idNumber digits 1–6. */
  dateOfBirth: string
  /** Consistent with idNumber digits 7–10 (0000–4999 female, 5000–9999 male). */
  gender: 'MALE' | 'FEMALE'
  email: string
  phone: string
  address: Address
  employment: Employment
  payroll: Payroll
  bank: BankAccount
  expenses: ExpenseBreakdown
  debts: DebtObligation[]
  loanRequest: LoanRequest
  nextOfKin: NextOfKin
}
