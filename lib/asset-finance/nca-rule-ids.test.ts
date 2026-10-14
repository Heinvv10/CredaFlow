import { describe, expect, it } from "vitest"
import { baselineConstraintSql } from "../db-baseline.test-helpers"
import { NCA_RULE_IDS } from "./nca-classifier"

// The database refuses a classification rule the classifier cannot return
// (20261013090000_asset_finance_foundation). Its two CHECKs list the ids by
// hand; this keeps them equal to NCA_RULE_IDS, the list NcaRuleId is built
// from, so a rule added on one side only goes red here.

/** The quoted values of the CHECK's `"column" IN (...)` list, in order. */
function checkedRuleIds(constraint: string, column: string): string[] {
  const sql = baselineConstraintSql(constraint)
  const list = new RegExp(`"${column}"\\s+IN\\s*\\(([^)]*)\\)`).exec(sql)
  if (!list) throw new Error(`${constraint}: no "${column}" IN (...) list`)
  const values = list[1].split(",").map((value) => value.trim())
  for (const value of values) {
    if (!/^'[A-Z_]+'$/.test(value)) throw new Error(`${constraint}: unexpected list entry ${value}`)
  }
  return values.map((value) => value.slice(1, -1))
}

describe("NCA classification rule ids: database CHECKs and the classifier agree", () => {
  it.each([
    ["LoanApplication_nca_classification_rule_known", "ncaClassificationRule"],
    ["NcaRegimeOverride_approved_classification_rule_known", "approvedClassificationRule"],
  ])("%s lists exactly NCA_RULE_IDS", (constraint, column) => {
    const ids = checkedRuleIds(constraint, column)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual([...NCA_RULE_IDS].sort())
  })

  it("allows NULL alongside the list (an unclassified application, a snapshot-less move to NCA)", () => {
    expect(baselineConstraintSql("LoanApplication_nca_classification_rule_known")).toMatch(
      /"ncaClassificationRule" IS NULL OR "ncaClassificationRule" IN \(/,
    )
    expect(baselineConstraintSql("NcaRegimeOverride_approved_classification_rule_known")).toMatch(
      /"approvedClassificationRule" IS NULL OR "approvedClassificationRule" IN \(/,
    )
  })
})
