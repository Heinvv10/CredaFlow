export type WizardMode = "staff" | "portal"

export interface ExpenseBreakdownInputs {
  housing: string
  transport: string
  food: string
  education: string
  insurance: string
  clothing: string
  entertainment: string
  medical: string
  other: string
  // Required when sum < NCA Reg 23A minimum; otherwise empty.
  belowMleJustification: string
}

export interface DebtObligationInput {
  // Wizard-local stable id used as a React key for the repeating row block.
  // Stripped before POST/PATCH — the API ignores it (or rejects it as
  // unknown).
  rowKey: string
  creditProvider: string
  accountType: string
  outstandingBalance: string
  monthlyInstalment: string
  notes: string
}

export const EMPTY_EXPENSE_BREAKDOWN: ExpenseBreakdownInputs = {
  housing: "", transport: "", food: "", education: "", insurance: "",
  clothing: "", entertainment: "", medical: "", other: "",
  belowMleJustification: "",
}

export interface ClientWizardData {
  // Step 1 Identity
  firstName: string
  lastName: string
  idNumber: string
  dateOfBirth: string
  gender: "" | "MALE" | "FEMALE" | "OTHER"
  email: string
  phone: string
  whatsapp: string
  // Step 2 Address
  addressLine1: string
  suburb: string
  city: string
  province: string
  postalCode: string
  // Step 3 Employment & income
  employmentStatus: string
  incomeSourceType: string
  employerName: string
  employerAddress: string
  employmentStartDate: string
  salaryPaymentDay: string
  monthlyIncome: string
  grossMonthlyIncome: string
  // Denormalised cached sum of `expenseBreakdown` written by the API. Kept as
  // a numeric string for parity with the other rand-string fields, but the
  // wizard no longer surfaces an input — the breakdown is the source of truth.
  monthlyExpenses: string
  expenseBreakdown: ExpenseBreakdownInputs
  debtObligations: DebtObligationInput[]
  bankName: string
  bankAccountNumber: string
  bankBranchCode: string
  accountType: string
  nextOfKinName: string
  nextOfKinPhone: string
  nextOfKinRelationship: string
  // Step 4 Compliance
  popiaConsentGiven: boolean
}

export const EMPTY_CLIENT_WIZARD_DATA: ClientWizardData = {
  firstName: "", lastName: "", idNumber: "", dateOfBirth: "",
  gender: "", email: "", phone: "", whatsapp: "",
  addressLine1: "",
  suburb: "", city: "", province: "", postalCode: "",
  employmentStatus: "", incomeSourceType: "",
  employerName: "", employerAddress: "",
  employmentStartDate: "", salaryPaymentDay: "",
  monthlyIncome: "", grossMonthlyIncome: "",
  monthlyExpenses: "",
  expenseBreakdown: { ...EMPTY_EXPENSE_BREAKDOWN },
  debtObligations: [],
  bankName: "", bankAccountNumber: "",
  bankBranchCode: "", accountType: "",
  nextOfKinName: "", nextOfKinPhone: "", nextOfKinRelationship: "",
  popiaConsentGiven: false,
}

export type ClientWizardStep = 1 | 2 | 3 | 4

export const CLIENT_WIZARD_STEP_LABELS = [
  "Identity",
  "Address",
  "Employment & income",
  "Review",
] as const
