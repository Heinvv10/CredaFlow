import { describe, expect, it } from "vitest"
import {
  affordabilityExpenseEvidenceIsIntact,
  affordabilityExpenseEvidenceNeedsMleJustification,
  createAffordabilityExpenseEvidence,
} from "@/lib/affordability/snapshot"
import { seedExpenseBreakdown } from "./seed-expense-breakdown"

// The public website apply route refuses a client whose itemised budget does
// not add up to the stored monthly expenses. The staging seed gives three
// clients an itemised budget, so each must sum to that client's own figure.
describe("seedExpenseBreakdown", () => {
  it.each([1_200_000, 900_000, 2_100_000, 1_234_567])(
    "sums to the stated monthly expenses (%i cents) and passes the evidence check",
    (expenses) => {
      const breakdown = seedExpenseBreakdown(expenses)
      expect(Object.values(breakdown).reduce((a, b) => a + b, 0)).toBe(expenses)

      const evidence = createAffordabilityExpenseEvidence({
        monthlyIncome: 2_800_000,
        monthlyExpenses: expenses,
        expenseBreakdown: breakdown,
      })
      expect(affordabilityExpenseEvidenceNeedsMleJustification(evidence)).toBe(false)
      expect(affordabilityExpenseEvidenceIsIntact(evidence)).toBe(true)
    },
  )
})
