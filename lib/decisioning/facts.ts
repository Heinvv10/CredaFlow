/**
 * The fact model: everything a rule or a scorecard characteristic may read.
 * One flat record per application, built by ./load-facts.ts at decision time.
 * Amounts are integer cents, rates are percentages (never rounded), a missing
 * fact is null. The bureau flags are null, not false, when no current bureau
 * check is on file: "no judgement on record" and "no record" are different, and a
 * rule on `bureauJudgement eq false` must not pass an applicant nobody checked.
 * The staff approval path recomputes affordability and the bureau gate itself
 * (the facts here are for the lender's policy, they never replace those gates).
 */
export const CHANNELS = ["PORTAL", "STAFF"] as const
export type Channel = (typeof CHANNELS)[number]

export const EMPLOYMENT_STATUSES = ["EMPLOYED", "PART_TIME", "SELF_EMPLOYED", "UNEMPLOYED", "STUDENT", "PENSIONER"] as const
export const INCOME_SOURCES = ["SALARY", "WAGES", "PENSION", "SOCIAL_GRANT", "BUSINESS_INCOME", "RENTAL_INCOME", "OTHER"] as const
export const PRODUCT_TYPES = ["MICRO", "PERSONAL", "PO_FUNDING", "ASSET_FINANCE"] as const

export interface DecisionFacts {
  productId: string
  productCode: string
  productType: string
  channel: Channel
  requestedAmountCents: number
  termDays: number
  ageYears: number | null
  employmentStatus: string | null
  incomeSourceType: string | null
  employmentMonths: number | null
  monthlyIncomeCents: number
  monthlyExpensesCents: number
  monthlyDebtCents: number
  instalmentCents: number | null
  ndiCents: number | null
  ndiCoverPct: number | null
  /** The staff approval gate's own verdict on these figures (lib/decision/affordability-gate.ts); null without an instalment. */
  affordabilityGatePasses: boolean | null
  /** Declared living expenses are below the Regulation 23A minimum. */
  expensesBelowMinimum: boolean
  dtiPct: number | null
  bureauAvailable: boolean
  bureauScore: number | null
  bureauUnscoreable: boolean | null
  bureauAdverse: boolean | null
  bureauJudgement: boolean | null
  bureauNotice: boolean | null
  bureauUnderDebtReview: boolean | null
  bureauDeceased: boolean | null
  isRepeatClient: boolean
  openLoansCount: number
}

export type FactName = keyof DecisionFacts
export type FactType = "number" | "string" | "boolean"

export interface FactDefinition {
  label: string
  type: FactType
  /** cents | days | years | months | % | score | count */
  unit?: string
  /** The values a string fact takes, when it is a closed list. */
  values?: readonly string[]
  description: string
}

export const FACT_DEFINITIONS = {
  productId: { label: "Product", type: "string", description: "Id of the loan product applied for." },
  productCode: { label: "Product code", type: "string", description: "Code of the loan product applied for." },
  productType: { label: "Product type", type: "string", values: PRODUCT_TYPES, description: "Kind of product applied for." },
  channel: { label: "Channel", type: "string", values: CHANNELS, description: "PORTAL when the client submitted the application themselves, STAFF when staff captured it." },
  requestedAmountCents: { label: "Requested amount", type: "number", unit: "cents", description: "The principal applied for." },
  termDays: { label: "Term", type: "number", unit: "days", description: "The term applied for." },
  ageYears: { label: "Age", type: "number", unit: "years", description: "Applicant's age today, from the date of birth on file; null when none." },
  employmentStatus: { label: "Employment status", type: "string", values: EMPLOYMENT_STATUSES, description: "Employment status on the client record; null when not captured." },
  incomeSourceType: { label: "Income source", type: "string", values: INCOME_SOURCES, description: "Main source of income on the client record; null when not captured." },
  employmentMonths: { label: "Time with employer", type: "number", unit: "months", description: "Whole months since the employment start date; null when not captured." },
  monthlyIncomeCents: { label: "Monthly income", type: "number", unit: "cents", description: "Net monthly income declared on the client record." },
  monthlyExpensesCents: { label: "Monthly expenses", type: "number", unit: "cents", description: "Monthly living expenses declared on the client record." },
  monthlyDebtCents: { label: "Monthly debt repayments", type: "number", unit: "cents", description: "The higher of the declared debt instalments and those the bureau shows." },
  instalmentCents: { label: "Proposed instalment", type: "number", unit: "cents", description: "Instalment on the requested terms, credit life excluded; null when it cannot be calculated." },
  ndiCents: { label: "Net disposable income", type: "number", unit: "cents", description: "Income less expenses and debt repayments, before this loan; null without income." },
  affordabilityGatePasses: { label: "Affordability gate passes", type: "boolean", description: "The approval affordability gate (NDI buffer and the 70% ratio) passes on these figures; missing without an instalment." },
  expensesBelowMinimum: { label: "Expenses below the Regulation 23A minimum", type: "boolean", description: "Declared living expenses are below the regulated minimum." },
  ndiCoverPct: { label: "NDI cover", type: "number", unit: "%", description: "Net disposable income as a percentage of the proposed instalment; null without an instalment." },
  dtiPct: { label: "Debt to income", type: "number", unit: "%", description: "(Debt repayments + proposed instalment) as a percentage of monthly income; null without income." },
  bureauAvailable: { label: "Bureau check on file", type: "boolean", description: "A current approval-grade bureau check exists for this review." },
  bureauScore: { label: "Bureau score", type: "number", unit: "score", description: "Score on the current bureau check; null when there is none or it is unscoreable." },
  bureauUnscoreable: { label: "Bureau: unscoreable", type: "boolean", description: "The bureau could not score the consumer. Missing when there is no current bureau check." },
  bureauAdverse: { label: "Bureau: adverse information", type: "boolean", description: "The bureau shows adverse account information. Missing when there is no current bureau check." },
  bureauJudgement: { label: "Bureau: judgement", type: "boolean", description: "The bureau shows a court judgement. Missing when there is no current bureau check." },
  bureauNotice: { label: "Bureau: notice", type: "boolean", description: "The bureau shows a notice (e.g. sequestration). Missing when there is no current bureau check." },
  bureauUnderDebtReview: { label: "Bureau: under debt review", type: "boolean", description: "The bureau shows the consumer under debt review. Missing when there is no current bureau check." },
  bureauDeceased: { label: "Bureau: deceased", type: "boolean", description: "The bureau reports the consumer as deceased. Missing when there is no current bureau check." },
  isRepeatClient: { label: "Repeat client", type: "boolean", description: "The client has had a loan with this lender before." },
  openLoansCount: { label: "Open loans", type: "number", unit: "count", description: "Loans with this lender that are not yet settled." },
} as const satisfies Record<FactName, FactDefinition>

export const FACT_NAMES = Object.keys(FACT_DEFINITIONS) as FactName[]

/**
 * The Client columns the facts are computed from, per fact (what ./load-facts.ts and ./affordability-facts.ts read:
 * the figures the approval affordability gate and the Regulation 23A check use are included). Every fact must be listed, so a new
 * fact cannot be added without saying where it comes from. A change of any of these on a client is a change of the inputs of that
 * client's open applications (lib/applications/input-staff.ts).
 */
const NDI_INPUTS = ["monthlyIncome", "monthlyExpenses", "expenseBreakdown", "debtObligations"] as const
export const FACT_CLIENT_SOURCES = {
  productId: [], productCode: [], productType: [], channel: [], requestedAmountCents: [], termDays: [],
  ageYears: ["dateOfBirth"],
  employmentStatus: ["employmentStatus"],
  incomeSourceType: ["incomeSourceType"],
  employmentMonths: ["employmentStartDate"],
  monthlyIncomeCents: ["monthlyIncome"],
  monthlyExpensesCents: ["monthlyExpenses", "expenseBreakdown"],
  monthlyDebtCents: ["debtObligations"],
  instalmentCents: [],
  ndiCents: NDI_INPUTS,
  affordabilityGatePasses: [...NDI_INPUTS, "grossMonthlyIncome"],
  expensesBelowMinimum: [...NDI_INPUTS, "grossMonthlyIncome"],
  ndiCoverPct: NDI_INPUTS,
  dtiPct: ["monthlyIncome", "debtObligations"],
  bureauAvailable: [], bureauScore: [], bureauUnscoreable: [], bureauAdverse: [], bureauJudgement: [], bureauNotice: [], bureauUnderDebtReview: [], bureauDeceased: [],
  isRepeatClient: [], openLoansCount: [],
} as const satisfies Record<FactName, readonly string[]>

/** Every Client column some fact reads, sorted. */
export const DECISION_INPUT_CLIENT_FIELDS: readonly string[] = [...new Set(Object.values(FACT_CLIENT_SOURCES).flat())].sort()
