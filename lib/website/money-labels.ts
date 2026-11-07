import { activeCurrency } from "@/lib/jurisdiction/active"
import { activeCurrencySymbol } from "@/lib/utils"

/**
 * The income, expense and debt field labels on the public qualify and calculator
 * pages. The catalogue says "(Rands)", which is right only for a lender billing in
 * ZAR; any other currency gets an English literal naming its symbol, because the
 * catalogue cannot change without resetting every language's review (lib/i18n/.claude.md).
 */
const NON_ZAR_LABELS = {
  incomeLabel: "Monthly Gross Income",
  expensesLabel: "Monthly Expenses",
  debtLabel: "Existing Monthly Debt Payments",
} as const

export type MoneyLabelKey = keyof typeof NON_ZAR_LABELS

export function moneyLabel(key: MoneyLabelKey, catalogueText: string): string {
  if (activeCurrency() === "ZAR") return catalogueText
  return `${NON_ZAR_LABELS[key]} (${activeCurrencySymbol()})`
}
