/**
 * Per flag code: what its rule checks and when it raises the flag (in words,
 * no figures), and the policy threshold the rule uses, read from
 * lib/credit-checks/policy.ts so an explanation can never state another one.
 * Reads policy values only; nothing here feeds a check.
 */
import {
  EXPENSE_GAP_MIN_CENTS,
  EXPENSE_GAP_MIN_SHARE,
  GAMBLING_INCOME_SHARE,
  INSTALMENT_MATCH_PCT,
  MODIFIED_AFTER_CREATION_TOLERANCE_MS,
  SALARY_AMOUNT_TOLERANCE_CENTS,
  SALARY_AMOUNT_TOLERANCE_PCT,
  SALARY_DATE_WINDOW_DAYS,
  STALE_STATEMENT_DAYS,
} from "@/lib/credit-checks/policy"
import { rand as r } from "./format"

/** Threshold facts as the model sees them: keys ending in Percent are percentages, amounts are rand strings. */
export type FlagSpecFacts = Record<string, string | number>

interface Spec {
  rule: string
  /** When the rule raises it, as the rule decides it; null for flags that are presence, not size. */
  raisedWhen: string | null
  thresholds: FlagSpecFacts
}

const SPECS: Record<string, Spec> = {
  GAMBLING: { rule: "Betting and lottery spend per month is compared with the client's monthly income.", raisedWhen: "It is raised when betting a month is at least the policy share of monthly income.", thresholds: { gamblingShareOfIncomePercent: GAMBLING_INCOME_SHARE * 100 } },
  LIVING_SPEND_ABOVE_DECLARED: {
    rule: "Living spend on the statements is compared with the monthly expenses the client declared.",
    raisedWhen: "It is raised when living spend a month is above the declared expenses by more than both the minimum gap and the minimum share of what was declared.",
    thresholds: { minimumGap: r(EXPENSE_GAP_MIN_CENTS), minimumGapShareOfDeclaredPercent: EXPENSE_GAP_MIN_SHARE * 100 },
  },
  SALARY_AMOUNT_MISMATCH: {
    rule: "The credit nearest the payslip's pay date is compared with the payslip's net pay.",
    raisedWhen: null,
    thresholds: { amountTolerancePercent: SALARY_AMOUNT_TOLERANCE_PCT, amountTolerance: r(SALARY_AMOUNT_TOLERANCE_CENTS), payDateWindowDays: SALARY_DATE_WINDOW_DAYS },
  },
  NO_SALARY_CREDIT: { rule: "The statements are searched for the payslip's net pay near its pay date.", raisedWhen: null, thresholds: { payDateWindowDays: SALARY_DATE_WINDOW_DAYS } },
  UNDISCLOSED_DEBIT_ORDER: {
    rule: "Recurring debit orders to credit providers are compared with the debts the client declared and the bureau reported; a debit order counts as a known debt when a declared or reported instalment is within the match tolerance of it.",
    raisedWhen: null,
    thresholds: { instalmentMatchTolerancePercent: INSTALMENT_MATCH_PCT },
  },
  RETURNED_DEBIT: { rule: "Debits the bank returned unpaid or could not collect are listed.", raisedWhen: null, thresholds: {} },
  PAYDAY_LENDER: { rule: "Transactions with short-term lenders are listed.", raisedWhen: null, thresholds: {} },
  STALE_STATEMENT: { rule: "The statement's end date is compared with the application date.", raisedWhen: "It is raised when the statement ends more than the maximum age before the application.", thresholds: { maximumAgeDays: STALE_STATEMENT_DAYS } },
  MODIFIED_AFTER_CREATION: { rule: "The PDF's modification time is compared with its creation time.", raisedWhen: "It is raised when the PDF records a modification more than the tolerance after its creation.", thresholds: { toleranceSeconds: MODIFIED_AFTER_CREATION_TOLERANCE_MS / 1000 } },
  BALANCE_MISMATCH: { rule: "Opening balance plus every transaction is compared with the printed closing balance.", raisedWhen: null, thresholds: {} },
  RUNNING_BALANCE_BREAK: { rule: "Each printed running balance is compared with the previous balance plus the row's amount.", raisedWhen: null, thresholds: {} },
  INCREMENTAL_UPDATE: { rule: "The PDF's structure is checked for saves made after it was first written.", raisedWhen: null, thresholds: {} },
  PRODUCER_UNEXPECTED: { rule: "The program that wrote the PDF is compared with the one the bank uses.", raisedWhen: null, thresholds: {} },
  HOLDER_NAME_MISMATCH: { rule: "The account holder printed on the statement is compared with the client's name.", raisedWhen: null, thresholds: {} },
}

const manual = (rule: string): Spec => ({ rule, raisedWhen: null, thresholds: {} })
Object.assign(SPECS, {
  NO_PAYSLIP: manual("No recent payslip is on file, so the salary on the statement could not be matched to a payslip."),
  PAYSLIP_UNVALIDATED: manual("The payslip's figures could not be validated, so the salary was not matched to it."),
  PAYSLIP_NOT_CLIENTS: manual("The payslip's name or ID number does not match the client."),
  SALARY_NOT_CHECKED: manual("No statement covers a whole pay window around the payslip's pay day, so the salary could not be matched."),
  NO_STATEMENT: manual("No recent bank statement is on file for the application."),
  UNREADABLE: manual("The statement could not be read, so no rule could check it."),
  UNVERIFIED_READ: manual("The statement was read but its balances could not be confirmed by arithmetic."),
  READ_INCOMPLETE: manual("The statement was read but its account holder or period could not be."),
  FIRST_ROW_UNVERIFIED: manual("The bank prints no opening balance, so the first transaction cannot be checked by arithmetic."),
  LAST_ROW_UNVERIFIED: manual("The bank prints no closing balance, so the last transaction cannot be checked by arithmetic."),
  ROWS_UNCHECKED: manual("Some rows print no running balance, so they are checked only together with the rows around them."),
  AUTHENTICITY_UNCHECKED: manual("The PDF carries no producer information, so the program that wrote it could not be checked."),
  PRIOR_OPEN_FLAGS: manual("Another application of the same client still has credit checks open."),
} satisfies Record<string, Spec>)

const GENERIC: Spec = { rule: "A rule raised this for an officer to review by hand.", raisedWhen: null, thresholds: {} }

/** The salary credit against net pay, from the evidence: the rule raises it on a difference either way. */
function salaryRaisedWhen(evidence: unknown): string {
  const e = (evidence ?? {}) as Record<string, unknown>
  const way = typeof e.creditCents === "number" && typeof e.netPayCents === "number" && e.creditCents !== e.netPayCents
    ? (e.creditCents > e.netPayCents ? "above" : "below")
    : null
  return way
    ? `The credit found is ${way} the payslip's net pay by more than the tolerance; the rule raises it on a difference either way.`
    : "It is raised when the credit found differs from the payslip's net pay by more than the tolerance, either way."
}

/** Betting with no income to compare it with: raised for any betting, and no share of income applies. */
const GAMBLING_NO_INCOME: Spec = {
  rule: "Betting and lottery spend per month is listed; the client's monthly income is not known, so it could not be compared with income.",
  raisedWhen: "It is raised for any betting when monthly income is not known.",
  thresholds: {},
}

export function flagSpec(code: string, evidence: unknown): Spec {
  const e = (evidence ?? {}) as Record<string, unknown>
  if (code === "GAMBLING" && typeof e.monthlyIncomeCents !== "number") return GAMBLING_NO_INCOME
  const spec = SPECS[code] ?? GENERIC
  return code === "SALARY_AMOUNT_MISMATCH" ? { ...spec, raisedWhen: salaryRaisedWhen(evidence) } : spec
}
