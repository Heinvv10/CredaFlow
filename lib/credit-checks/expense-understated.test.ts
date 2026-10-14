import { describe, expect, it } from "vitest"
import { CATEGORISER_VERSION } from "@/lib/statement-analysis/categorise"
import { expenseUnderstated, understated } from "./expense-understated"
import { codes, facts, statement, tx } from "./facts.test-helpers"
import { fingerprint, runChecks } from "./run-checks"
import { EXPENSE_UNDERSTATED_ENABLED } from "./policy"

/** About R6,000 a month of living spend over July–September 2026 (92 days), plus spend that never counts. */
function rows() {
  const out = []
  for (const m of ["07", "08", "09"]) {
    out.push(tx(`2026-${m}-02`, "Card Purchase: SHOPRITE", -300_000))
    out.push(tx(`2026-${m}-04`, "Prepaid Airtime: VODACOM", -50_000))
    out.push(tx(`2026-${m}-15`, "Card Purchase: SYNTH FUEL ENGEN", -150_000))
    out.push(tx(`2026-${m}-20`, "Card Purchase: PEP STORES", -103_000))
    out.push(tx(`2026-${m}-05`, "DebiCheck: SYNTHLEND FINANCE", -125_000))
    out.push(tx(`2026-${m}-06`, "Card Purchase: HOLLYWOODBETS", -80_000))
    out.push(tx(`2026-${m}-07`, "ATM Cash Withdrawal", -200_000))
    out.push(tx(`2026-${m}-08`, "Payment To: J SOAP", -90_000))
    out.push(tx(`2026-${m}-25`, "Payment Received: SALARY SYNTHCO", 1_845_000))
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}
const withDeclared = (declaredExpensesCents: number | null | undefined, over = {}) =>
  facts({ declaredExpensesCents, statements: [statement(rows(), over)] })

describe("understated", () => {
  it("needs the gap to exceed R1,500, not merely reach it", () => {
    expect(understated(500_000 + 150_000, 500_000)).toBe(false)
    expect(understated(500_000 + 150_001, 500_000)).toBe(true)
  })

  it("needs the gap to exceed 25% of what was declared, not merely reach it", () => {
    expect(understated(1_000_000, 800_000)).toBe(false)
    expect(understated(1_000_001, 800_000)).toBe(true)
  })

  it("flags any living spend over R1,500 when nothing was declared", () => {
    expect(understated(150_001, 0)).toBe(true)
    expect(understated(150_000, 0)).toBe(false)
  })
})

describe("expenseUnderstated", () => {
  it("raises one flag with the evidence an officer needs", () => {
    const [flag, ...rest] = expenseUnderstated(withDeclared(300_000))
    expect(rest).toEqual([])
    expect(flag).toMatchObject({ check: "EXPENSE_UNDERSTATED", code: "LIVING_SPEND_ABOVE_DECLARED" })
    const e = flag.evidence as Record<string, unknown>
    expect(e).toMatchObject({ documentIds: ["doc-1"], categoriserVersion: CATEGORISER_VERSION, months: ["2026-07", "2026-08", "2026-09"], coverageDays: 92, declaredCents: 300_000 })
    // R6,030 a month of food, airtime, fuel and clothing over 92 days.
    expect(e.livingMonthlyCents).toBe(Math.round((3 * 603_000) / (92 / 30.44)))
    expect(e.gapCents).toBe((e.livingMonthlyCents as number) - 300_000)
    expect(Object.keys(e.livingByCategoryMonthlyCents as object).sort()).toEqual(["CLOTHING", "FOOD", "TRANSPORT", "UTILITIES_TELECOM"])
    expect(Object.keys(e.excludedMonthlyCents as object).sort()).toEqual(["CASH_WITHDRAWAL", "CREDIT_INSTALMENT", "GAMBLING", "UNCATEGORISED"])
  })

  it("does not flag a declaration that covers the living spend", () => {
    expect(expenseUnderstated(withDeclared(600_000))).toEqual([])
  })

  it("does not flag without a declared figure or on unreconciled statements", () => {
    expect(expenseUnderstated(withDeclared(undefined))).toEqual([])
    expect(expenseUnderstated(withDeclared(null))).toEqual([])
    expect(expenseUnderstated(withDeclared(300_000, { balanceCheck: "FAIL" }))).toEqual([])
  })

  it("does not flag under 28 days of statements", () => {
    const upTo = (end: string) => {
      const s = statement(rows().filter((t) => t.date <= end))
      s.read!.periodEnd = end
      return facts({ declaredExpensesCents: 0, statements: [s] })
    }
    expect(expenseUnderstated(upTo("2026-07-27"))).toEqual([])
    expect(codes(expenseUnderstated(upTo("2026-07-28")))).toEqual(["LIVING_SPEND_ABOVE_DECLARED"])
  })

  it("keys the finding on the categoriser version, so new rules are new evidence", () => {
    const [flag] = expenseUnderstated(withDeclared(300_000))
    expect(flag.key.startsWith(`${CATEGORISER_VERSION}|`)).toBe(true)
    expect(fingerprint(flag)).not.toBe(fingerprint({ ...flag, key: flag.key.replace(CATEGORISER_VERSION, "categoriser-v0") }))
  })

  it("is off in runChecks until the categoriser passes its accuracy gate", () => {
    expect(EXPENSE_UNDERSTATED_ENABLED).toBe(false)
    expect(runChecks(withDeclared(300_000)).map((c) => c.check)).not.toContain("EXPENSE_UNDERSTATED")
  })
})
