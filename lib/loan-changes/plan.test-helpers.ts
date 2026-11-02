/** Rows a booked loan really has, and what the plan tests share. Not a test file. */
import { expect } from "vitest"
import { generateSchedule } from "@/lib/product-engine/schedule"
import type { RepaymentTerms } from "@/lib/product-engine/types"
import { planInPlace, type PlanInput, type PlanRow } from "./plan"

export const DAY = 86_400_000
/** The instant of a SAST day at noon: dates here are fixed, so the suite is independent of the day it runs. */
export const at = (day: string) => new Date(`${day}T10:00:00.000Z`)
export const START = at("2026-01-15")
export const NO_GRACE = { graceKind: "NONE", graceInstalments: 0 } as const
export const monthly = (instalments: number, over: Partial<RepaymentTerms> = {}): RepaymentTerms => ({ frequency: "MONTHLY", structure: "AMORTISING", ...NO_GRACE, instalments, ...over })

export interface LoanShape { principal?: number; rate?: number; model?: "REDUCING_BALANCE" | "FLAT"; fee?: number; start?: Date; terms?: RepaymentTerms }

/** The rows a booked loan really has: the engine's, with `paid` of them paid. */
export function loanRows(shape: LoanShape = {}, paid = 0): PlanRow[] {
  const { principal = 600_000, rate = 0.04, model = "REDUCING_BALANCE", fee = 5_000, start = START, terms = monthly(6) } = shape
  return generateSchedule({ principalCents: principal, interestRatePm: rate, interestModel: model, monthlyServiceFeeCents: fee, startDate: start, terms }).schedule.map((r, i) => ({
    id: `r${i + 1}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue,
    totalPaid: i < paid ? r.totalDue : 0, paidAt: i < paid ? r.dueDate : null,
  }))
}

export function input(rows: PlanRow[], change: PlanInput["change"], over: Partial<PlanInput> & { shape?: LoanShape } = {}): PlanInput {
  const { shape = {}, ...rest } = over
  return {
    loan: { principal: rows.reduce((s, r) => s + r.principalDue, 0), interestRatePm: shape.rate ?? 0.04, interestModel: shape.model ?? "REDUCING_BALANCE", monthlyServiceFee: shape.fee ?? 5_000, startDate: shape.start ?? START },
    rows, frequency: "MONTHLY", structure: "AMORTISING", asOf: at("2026-04-20"), change, ...rest,
  }
}

export function reconciles(given: PlanInput, plan: ReturnType<typeof planInPlace>) {
  const rows = plan.rows
  expect(rows.reduce((s, r) => s + r.principalDue, 0)).toBe(given.loan.principal)
  expect(rows.reduce((s, r) => s + r.interestDue, 0)).toBe(plan.totalInterest)
  expect(rows.reduce((s, r) => s + r.totalDue, 0)).toBe(plan.totalRepayable)
  for (const r of rows) {
    expect(r.totalDue).toBe(r.principalDue + r.interestDue + r.feesDue)
    for (const value of [r.principalDue, r.interestDue, r.feesDue, r.totalDue]) expect(Number.isInteger(value) && value >= 0).toBe(true)
  }
}

export const interestOf = (rows: readonly { interestDue: number }[]) => rows.reduce((s, r) => s + r.interestDue, 0)
export const feesOf = (rows: readonly { feesDue: number }[]) => rows.reduce((s, r) => s + r.feesDue, 0)
export const totalOf = (rows: readonly { totalDue: number }[]) => rows.reduce((s, r) => s + r.totalDue, 0)
export const written = (plan: ReturnType<typeof planInPlace>): PlanRow[] => plan.rows.map((r, i) => ({ ...r, id: `n${i}`, paidAt: null }))
export const rate = (interestRatePm: number) => ({ type: "RATE_CHANGE" as const, interestRatePm })
