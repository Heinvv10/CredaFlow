/**
 * Puts each statement transaction in one category (categories.ts). A pure
 * function of the transaction, the client's name and the read's stored model
 * labels: categories are computed on read, never stored, so
 * CATEGORISER_VERSION names the rules a figure or a flag came from (and
 * StatementAnalysis.modelCategoriesVersion the model labels).
 *
 * Rules run in order and the first match decides; `rule` says which. Words
 * match whole, upper-cased (policy.ts mentions()). The checks' own lists come
 * from lib/credit-checks/policy.ts; merchants.ts adds names only the
 * categoriser uses, and za-brands.ts (generated from public brand data) is
 * tried last.
 */
import {
  CREDIT_PROVIDERS, CREDIT_WORD_MARKERS, GAMBLING_MERCHANTS, PAYDAY_LENDERS, RETURNED_DEBIT_MARKERS,
} from "@/lib/credit-checks/policy"
import type { Category } from "./categories"
import {
  BANK_FEE_WORDS, CASH_WORDS, EXTRA_CREDIT, EXTRA_GAMBLING, LIVING_MERCHANTS, OWN_TRANSFER_WORDS, SALARY_WORDS, SAVINGS_WORDS,
} from "./merchants"
import { modelLabelFor } from "./model-labels"
import type { StatementTransaction } from "./types"
import { ZA_BRANDS } from "./za-brands"

export { isLiving, LIVING_CATEGORIES, type Category, type LivingCategory } from "./categories"

/** Bump when a rule or a word list changes what a transaction is categorised as. */
export const CATEGORISER_VERSION = "categoriser-v4"

export interface CategoriseContext {
  /** The client's name: a transfer to it is a transfer between their own accounts. */
  clientName: string | null
  /** The read's stored model labels (StatementAnalysis.modelCategories), if any. */
  modelLabels?: unknown
}

export interface Categorised {
  category: Category
  rule: string
  /** The category came from the model, not a rule: say so wherever it is shown. */
  modelAssigned?: true
}

/** One pattern that matches any of `names` as whole words in an upper-cased description. */
function words(names: readonly string[]): RegExp {
  const alternatives = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(`(?:^|[^A-Z0-9])(?:${alternatives.join("|")})(?:[^A-Z0-9]|$)`)
}

const GAMBLING = words(GAMBLING_MERCHANTS)
const GAMBLING_EXTRA = words(EXTRA_GAMBLING)
const CREDIT = words([...CREDIT_PROVIDERS, ...PAYDAY_LENDERS])
const CREDIT_EXTRA = words(EXTRA_CREDIT)
const OWN = words(OWN_TRANSFER_WORDS)
const SAVINGS = words(SAVINGS_WORDS)
const FEES = words(BANK_FEE_WORDS)
const CASH = words(CASH_WORDS)
const SALARY = words(SALARY_WORDS)
const LIVING = LIVING_MERCHANTS.map(([category, names]) => [category, words(names)] as const)
const BRANDS = ZA_BRANDS.map(([category, names]) => [category, words(names)] as const)
const EDUCATION = LIVING.find(([c]) => c === "EDUCATION")![1]

/** Every word of the client's name (3+ letters) appears in the description. */
function namesClient(upper: string, clientName: string | null): boolean {
  const parts = (clientName ?? "").toUpperCase().split(/[^A-Z]+/).filter((p) => p.length >= 3)
  return parts.length >= 2 && parts.every((p) => words([p]).test(upper))
}

/** Rules first; a debit no rule categorises takes the read's model label, if it has one. */
export function categorise(tx: StatementTransaction, ctx: CategoriseContext): Categorised {
  const byRule = categoriseByRules(tx, ctx)
  if (byRule.category !== "UNCATEGORISED" || tx.amountCents >= 0) return byRule
  const label = modelLabelFor(ctx.modelLabels, tx.description)
  return label ? { category: label, rule: "model", modelAssigned: true } : byRule
}

function categoriseByRules(tx: StatementTransaction, ctx: CategoriseContext): Categorised {
  const d = tx.description.toUpperCase()
  const is = (category: Category, rule: string): Categorised => ({ category, rule })
  if (tx.amountCents > 0) {
    if (OWN.test(d) || namesClient(d, ctx.clientName)) return is("TRANSFER_OWN", "transfer:own")
    if (SALARY.test(d)) return is("SALARY_INCOME", "income:salary")
    return is("OTHER_INCOME", "income:other")
  }
  if (RETURNED_DEBIT_MARKERS.test(d)) return is("RETURNED_DEBIT", "policy:RETURNED_DEBIT_MARKERS")
  if (GAMBLING.test(d)) return is("GAMBLING", "policy:GAMBLING_MERCHANTS")
  if (GAMBLING_EXTRA.test(d)) return is("GAMBLING", "merchant:GAMBLING")
  if (CREDIT.test(d) || CREDIT_WORD_MARKERS.test(d)) return is("CREDIT_INSTALMENT", "policy:CREDIT_PROVIDERS")
  if (CREDIT_EXTRA.test(d)) return is("CREDIT_INSTALMENT", "merchant:CREDIT")
  if (OWN.test(d) || namesClient(d, ctx.clientName)) return is("TRANSFER_OWN", "transfer:own")
  if (SAVINGS.test(d)) return is("SAVINGS_INVESTMENT", "merchant:SAVINGS")
  // School fees are education, not a bank charge.
  if (EDUCATION.test(d)) return is("EDUCATION", "merchant:EDUCATION")
  if (FEES.test(d)) return is("BANK_FEES", "merchant:BANK_FEES")
  if (CASH.test(d)) return is("CASH_WITHDRAWAL", "merchant:CASH")
  for (const [category, pattern] of LIVING) if (pattern.test(d)) return is(category, `merchant:${category}`)
  for (const [category, pattern] of BRANDS) if (pattern.test(d)) return is(category, `brand:${category}`)
  return is("UNCATEGORISED", "none")
}
