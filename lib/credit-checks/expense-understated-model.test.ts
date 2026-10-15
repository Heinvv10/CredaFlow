import { describe, expect, it } from "vitest"
import { CATEGORISER_VERSION } from "@/lib/statement-analysis/categorise"
import { expenseUnderstated } from "./expense-understated"
import { facts, statement, tx } from "./facts.test-helpers"

/** R4,000 a month at a grocer no rule knows, R2,000 at one a rule does, July–September 2026. */
function rows() {
  const out = []
  for (const m of ["07", "08", "09"]) {
    out.push(tx(`2026-${m}-02`, "Card Purchase: SYNTH ZOLA TRADING 4411", -400_000))
    out.push(tx(`2026-${m}-03`, "Card Purchase: SHOPRITE", -200_000))
    out.push(tx(`2026-${m}-08`, "Payment To: J SOAP", -90_000))
    out.push(tx(`2026-${m}-25`, "Payment Received: SALARY SYNTHCO", 1_845_000))
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}
const labels = { "SYNTH ZOLA TRADING": "FOOD", "J SOAP": "UNCATEGORISED" }
const flagFor = (modelLabels: unknown, declared = 200_000) =>
  expenseUnderstated(facts({ declaredExpensesCents: declared, statements: [{ ...statement(rows()), modelLabels }] }))

describe("expenseUnderstated with model labels", () => {
  it("counts a model-labelled row as living spend and names it in the evidence as model-assigned", () => {
    const [flag] = flagFor(labels)
    expect(flag.summary).toContain("model-assigned")
    const e = flag.evidence as { modelAssigned: { rowCount: number; livingMonthlyCents: number; rows: Array<{ description: string; category: string }> } }
    expect(e.modelAssigned.rowCount).toBe(3)
    expect(e.modelAssigned.livingMonthlyCents).toBeGreaterThan(390_000)
    expect(e.modelAssigned.rows.map((r) => [r.description, r.category])).toEqual(Array(3).fill(["Card Purchase: SYNTH ZOLA TRADING 4411", "FOOD"]))
  })

  it("rules alone: no model-assigned rows, no flag on spend the rules cannot see", () => {
    expect(flagFor(null)).toEqual([])
  })

  it("keys the finding on the model's rows, so labels arriving later are a new finding", () => {
    const [withModel] = flagFor(labels, 0)
    const [rulesOnly] = flagFor(null, 0)
    expect(rulesOnly.key).not.toContain("|model:")
    expect(withModel.key.startsWith(`${CATEGORISER_VERSION}|`)).toBe(true)
    expect(withModel.key).toMatch(/\|model:[0-9a-f]{16}$/)
    expect(withModel.key).not.toBe(rulesOnly.key)
    expect(rulesOnly.summary).not.toContain("model-assigned")
  })
})
