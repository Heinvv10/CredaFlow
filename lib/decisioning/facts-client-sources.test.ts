import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DECISION_INPUT_CLIENT_FIELDS, FACT_CLIENT_SOURCES, FACT_NAMES } from "./facts"

describe("the client fields a decision fact reads (FACT_CLIENT_SOURCES)", () => {
  it("names a source (possibly none) for every fact, and nothing that is not a fact", () => {
    expect(Object.keys(FACT_CLIENT_SOURCES).sort()).toEqual([...FACT_NAMES].sort())
  })

  it("derives the fields whose change is a change of decision inputs", () => {
    expect(DECISION_INPUT_CLIENT_FIELDS).toEqual([
      "dateOfBirth", "debtObligations", "employmentStartDate", "employmentStatus", "expenseBreakdown",
      "grossMonthlyIncome", "incomeSourceType", "monthlyExpenses", "monthlyIncome",
    ])
  })

  // A drift guard: a client column read where the facts are built must be in the list, or an edit of it would not count.
  it("covers every client column the fact loaders read", () => {
    const read = new Set<string>()
    for (const file of ["load-facts.ts", "affordability-facts.ts"]) {
      for (const match of readFileSync(join(__dirname, file), "utf8").matchAll(/\bclient\.([A-Za-z]+)/g)) read.add(match[1])
    }
    // Identity and bookkeeping columns are not inputs of a fact.
    const notInputs = new Set(["id", "tenantId", "idNumber"])
    expect([...read].filter((field) => !notInputs.has(field) && !DECISION_INPUT_CLIENT_FIELDS.includes(field))).toEqual([])
  })
})
