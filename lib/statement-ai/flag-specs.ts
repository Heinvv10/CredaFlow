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
  BALANCE_MISMATCH: { rule: "A statement as the bank issues it adds up to the cent, so a gap between the sum of its rows and its last printed figure means a row was misread, left out or changed after the bank issued it.", raisedWhen: null, thresholds: {} },
  RUNNING_BALANCE_BREAK: { rule: "Banks print a balance after every row, each carried forward from the one before; a figure that breaks that chain points to a misread or a changed amount at that spot.", raisedWhen: null, thresholds: {} },
  INCREMENTAL_UPDATE: { rule: "The PDF's structure is checked for saves made after it was first written.", raisedWhen: null, thresholds: {} },
  PRODUCER_UNEXPECTED: { rule: "The program that wrote the PDF is compared with the one the bank uses.", raisedWhen: null, thresholds: {} },
  HOLDER_NAME_MISMATCH: { rule: "A statement shows income and spending only for the person who holds the account; another person's account would show money the client may not have.", raisedWhen: null, thresholds: {} },
}

const manual = (rule: string): Spec => ({ rule, raisedWhen: null, thresholds: {} })
Object.assign(SPECS, {
  NO_PAYSLIP: manual("The salary rule compares the net pay a payslip states with the credits that arrive around its pay date; that is what ties the stated income to money the client receives, and without a payslip it has nothing to compare."),
  PAYSLIP_UNVALIDATED: manual("The salary rule uses a payslip only when its gross pay less its deductions gives its net pay; a slip whose sums do not agree may carry a misread net pay, so the rule does not compare it."),
  PAYSLIP_NOT_CLIENTS: manual("A payslip shows income only for the person it names, so the salary rule uses a payslip only when it is the client's own; someone else's would show income the client does not earn."),
  SALARY_NOT_CHECKED: manual("The salary rule looks for the credit only a fixed number of days either side of the pay date, and only where the same statement spans all those days, so that a missing credit means the money did not arrive, not that it fell outside the statement."),
  NO_STATEMENT: manual("The rules on income, spending, debit orders and the document itself all read the transactions, so with nothing to read they did not run."),
  UNREADABLE: manual("The rules work on the transactions extracted from the file, so with nothing extracted they did not run here: its income, spending and document checks are missing."),
  UNVERIFIED_READ: manual("The statement was read but its balances could not be confirmed by arithmetic."),
  READ_INCOMPLETE: manual("The holder's name is what ties the account to the client, and the dates place it against the application date and the pay date; without either, those rules cannot run on it."),
  FIRST_ROW_UNVERIFIED: manual("Each row's amount is checked by working from the balance before it to the one after it; here the starting figure is worked out from the first row itself, so a changed first amount moves that figure with it and still adds up."),
  LAST_ROW_UNVERIFIED: manual("The whole statement is summed to its end figure; here that figure is taken from the last row's own balance, so that row's amount and balance could change together and the sum would still agree."),
  ROWS_UNCHECKED: manual("A row that prints its own balance is checked on its own; rows without a balance are covered only by the next printed balance, so changes that cancel out within such a run would still add up."),
  AUTHENTICITY_UNCHECKED: manual("The PDF carries no producer information, so the program that wrote it could not be checked."),
  PRIOR_OPEN_FLAGS: manual("Findings on an earlier application describe the same client and often the same documents; deciding this application first would let a question raised earlier go unanswered."),
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

/** Whether the code has an explanation of its own, not the generic one. */
export const hasFlagSpec = (code: string): boolean => Object.hasOwn(SPECS, code)

export function flagSpec(code: string, evidence: unknown): Spec {
  const e = (evidence ?? {}) as Record<string, unknown>
  if (code === "GAMBLING" && typeof e.monthlyIncomeCents !== "number") return GAMBLING_NO_INCOME
  const spec = SPECS[code] ?? GENERIC
  return code === "SALARY_AMOUNT_MISMATCH" ? { ...spec, raisedWhen: salaryRaisedWhen(evidence) } : spec
}
