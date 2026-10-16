/**
 * What of a client record is the loan book, withheld from a role without
 * view_loan_book (lib/security/loan-book-scope.ts): the client's applications
 * and loans, its affordability evidence (expense breakdown, declared debt) and
 * the financial figures the lending decision reads. Identity, contact, KYC,
 * consent and documents stay: an INSURANCE_OFFICER works the client for cover.
 */
export const LOAN_BOOK_CLIENT_RELATIONS = ["applications", "loans", "expenseBreakdown", "debtObligations"] as const
export const LOAN_BOOK_CLIENT_FIELDS = [
  "monthlyIncome", "grossMonthlyIncome", "monthlyExpenses", "monthlyExpensesDeclaredAt",
  "incomeSourceType", "salaryPaymentDay", "creditScore",
] as const

/** The client as an API returns it to a role without the loan book: those keys removed. */
export function clientWithoutLoanBook<T extends Record<string, unknown>>(client: T): Omit<T, (typeof LOAN_BOOK_CLIENT_RELATIONS)[number] | (typeof LOAN_BOOK_CLIENT_FIELDS)[number]> {
  const out: Record<string, unknown> = { ...client }
  for (const key of [...LOAN_BOOK_CLIENT_RELATIONS, ...LOAN_BOOK_CLIENT_FIELDS]) delete out[key]
  return out as Omit<T, (typeof LOAN_BOOK_CLIENT_RELATIONS)[number] | (typeof LOAN_BOOK_CLIENT_FIELDS)[number]>
}

/** The client as a page renders it for a role without the loan book: the relations emptied, the shape kept. */
export function clientRelationsWithoutLoanBook<T extends { applications: unknown[]; loans: unknown[]; debtObligations: unknown[]; expenseBreakdown: unknown }>(client: T): T {
  return { ...client, applications: [], loans: [], debtObligations: [], expenseBreakdown: null }
}

/**
 * A client document's lending read, withheld from a role without the loan
 * book: the extraction (payslip income, bank statement lines) and the
 * validation that compares it with the application. The file and its status
 * stay.
 */
export const LOAN_BOOK_DOCUMENT_FIELDS = ["extractionResult", "validationResult", "validationScore", "validationMismatch"] as const

export function documentWithoutLoanBook<T extends Record<string, unknown>>(doc: T): Omit<T, (typeof LOAN_BOOK_DOCUMENT_FIELDS)[number]> {
  const out: Record<string, unknown> = { ...doc }
  for (const key of LOAN_BOOK_DOCUMENT_FIELDS) delete out[key]
  return out as Omit<T, (typeof LOAN_BOOK_DOCUMENT_FIELDS)[number]>
}
