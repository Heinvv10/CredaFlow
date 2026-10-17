/**
 * Per flag code: what its rule checks (in words, no figures), which way its
 * figure departs, and the policy threshold the rule uses, read from
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
import type { Direction } from "./post-check"

/** Threshold facts as the model sees them: keys ending in Percent are percentages, amounts are rand strings. */
export type FlagSpecFacts = Record<string, string | number>

interface Spec {
  rule: string
  direction: Direction | null
  thresholds: FlagSpecFacts
}

const SPECS: Record<string, Spec> = {
  GAMBLING: { rule: "Betting and lottery spend is compared with the client's monthly income.", direction: "ABOVE", thresholds: { gamblingShareOfIncomePercent: GAMBLING_INCOME_SHARE * 100 } },
  LIVING_SPEND_ABOVE_DECLARED: {
    rule: "Living spend on the statements is compared with the monthly expenses the client declared.",
    direction: "ABOVE",
    thresholds: { minimumGap: r(EXPENSE_GAP_MIN_CENTS), minimumGapShareOfDeclaredPercent: EXPENSE_GAP_MIN_SHARE * 100 },
  },
  SALARY_AMOUNT_MISMATCH: {
    rule: "The credit nearest the payslip's pay date is compared with the payslip's net pay.",
    direction: null,
    thresholds: { amountTolerancePercent: SALARY_AMOUNT_TOLERANCE_PCT, amountTolerance: r(SALARY_AMOUNT_TOLERANCE_CENTS), payDateWindowDays: SALARY_DATE_WINDOW_DAYS },
  },
  NO_SALARY_CREDIT: { rule: "The statements are searched for the payslip's net pay near its pay date.", direction: null, thresholds: { payDateWindowDays: SALARY_DATE_WINDOW_DAYS } },
  UNDISCLOSED_DEBIT_ORDER: { rule: "Debit orders to credit providers are compared with the debts the client declared and the bureau reported.", direction: null, thresholds: { instalmentMatchPercent: INSTALMENT_MATCH_PCT } },
  RETURNED_DEBIT: { rule: "Debits the bank returned unpaid or could not collect are listed.", direction: null, thresholds: {} },
  PAYDAY_LENDER: { rule: "Transactions with short-term lenders are listed.", direction: null, thresholds: {} },
  STALE_STATEMENT: { rule: "The statement's end date is compared with the application date.", direction: "ABOVE", thresholds: { maximumAgeDays: STALE_STATEMENT_DAYS } },
  MODIFIED_AFTER_CREATION: { rule: "The PDF's modification time is compared with its creation time.", direction: "ABOVE", thresholds: { toleranceSeconds: MODIFIED_AFTER_CREATION_TOLERANCE_MS / 1000 } },
  BALANCE_MISMATCH: { rule: "Opening balance plus every transaction is compared with the printed closing balance.", direction: null, thresholds: {} },
  RUNNING_BALANCE_BREAK: { rule: "Each printed running balance is compared with the previous balance plus the row's amount.", direction: null, thresholds: {} },
  INCREMENTAL_UPDATE: { rule: "The PDF's structure is checked for saves made after it was first written.", direction: null, thresholds: {} },
  PRODUCER_UNEXPECTED: { rule: "The program that wrote the PDF is compared with the one the bank uses.", direction: null, thresholds: {} },
  HOLDER_NAME_MISMATCH: { rule: "The account holder printed on the statement is compared with the client's name.", direction: null, thresholds: {} },
}

const GENERIC: Spec = { rule: "A rule raised this for an officer to review by hand.", direction: null, thresholds: {} }

/** The salary credit's direction comes from the evidence: above or below net pay. */
function salaryDirection(evidence: unknown): Direction | null {
  const e = (evidence ?? {}) as Record<string, unknown>
  if (typeof e.creditCents !== "number" || typeof e.netPayCents !== "number" || e.creditCents === e.netPayCents) return null
  return e.creditCents > e.netPayCents ? "ABOVE" : "BELOW"
}

export function flagSpec(code: string, evidence: unknown): Spec {
  const spec = SPECS[code] ?? GENERIC
  return code === "SALARY_AMOUNT_MISMATCH" ? { ...spec, direction: salaryDirection(evidence) } : spec
}
