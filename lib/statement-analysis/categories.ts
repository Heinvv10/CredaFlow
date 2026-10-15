/**
 * The transaction categories (goal 2026-10-14 §4). Living categories are the
 * client's own spending, the ones ClientExpenseBreakdown declares (utilities
 * and telecom under "other"); everything else is shown but never counted as
 * living spend.
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

/** Average days in a month: spend over a period is reported per month of this length. */
export const MONTH_DAYS = 30.44
