/**
 * The transaction categories (goal 2026-10-14 §4). Living categories are the
 * client's own spending, each mapped to the declared-expense field it is
 * compared with (ClientExpenseBreakdown); everything else is shown but never
 * counted as living spend.
 */
export const LIVING_CATEGORIES = [
  "HOUSING", "TRANSPORT", "FOOD", "EDUCATION", "INSURANCE", "CLOTHING", "ENTERTAINMENT", "MEDICAL", "UTILITIES_TELECOM",
] as const

export const OTHER_CATEGORIES = [
  "SALARY_INCOME", "OTHER_INCOME", "TRANSFER_OWN", "SAVINGS_INVESTMENT", "CASH_WITHDRAWAL", "CREDIT_INSTALMENT",
  "GAMBLING", "RETURNED_DEBIT", "BANK_FEES", "UNCATEGORISED",
] as const

export type LivingCategory = (typeof LIVING_CATEGORIES)[number]
export type Category = LivingCategory | (typeof OTHER_CATEGORIES)[number]

export function isLiving(c: Category): c is LivingCategory {
  return (LIVING_CATEGORIES as readonly string[]).includes(c)
}

/** The ClientExpenseBreakdown field each living category is declared under. */
export const EXPENSE_FIELD: Record<LivingCategory, string> = {
  HOUSING: "housing", TRANSPORT: "transport", FOOD: "food", EDUCATION: "education", INSURANCE: "insurance",
  CLOTHING: "clothing", ENTERTAINMENT: "entertainment", MEDICAL: "medical", UTILITIES_TELECOM: "other",
}
