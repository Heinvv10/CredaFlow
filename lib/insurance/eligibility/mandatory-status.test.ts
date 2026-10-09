import { describe, expect, it } from "vitest"
import type { EligibilityLifeScope, EligibilityRuleType } from "@prisma/client"
import { mandatoryRuleStatus } from "./mandatory-status"
import { MANDATORY_RULE_TYPES } from "./evaluate"
import type { EligibilityRuleInput } from "./failures"

let seq = 0
function rule(
  ruleType: EligibilityRuleType,
  lifeScope: EligibilityLifeScope,
  numericValue: number | null,
  active = true
): EligibilityRuleInput {
  seq += 1
  return { id: `r${seq}`, ruleType, lifeScope, numericValue, active }
}

/** Every mandatory term captured once, at ALL_LIVES. The baseline "done" card. */
function completeRules(): EligibilityRuleInput[] {
  return [
    rule("MIN_ENTRY_AGE", "ALL_LIVES", 18),
    rule("MAX_ENTRY_AGE", "ALL_LIVES", 65),
    rule("MAX_COVER", "ALL_LIVES", 50000),
    rule("WAITING_PERIOD_DAYS", "ALL_LIVES", 180),
  ]
}

function statusFor(rules: EligibilityRuleInput[], ruleType: EligibilityRuleType) {
  const found = mandatoryRuleStatus(rules).find((s) => s.ruleType === ruleType)
  if (!found) throw new Error(`${ruleType} is not screened as mandatory`)
  return found
}

describe("mandatoryRuleStatus", () => {
  it("reports every mandatory rule type, and only those", () => {
    expect(mandatoryRuleStatus([]).map((s) => s.ruleType)).toEqual([...MANDATORY_RULE_TYPES])
  })

  it("reports nothing missing once every mandatory term is captured at ALL_LIVES", () => {
    const statuses = mandatoryRuleStatus(completeRules())
    expect(statuses.every((s) => s.unresolved.length === 0)).toBe(true)
    expect(statuses.map((s) => s.reason)).toEqual([null, null, null, null])
  })

  it("names every life type when a term is absent entirely", () => {
    const rules = completeRules().filter((r) => r.ruleType !== "MAX_COVER")
    const status = statusFor(rules, "MAX_COVER")
    expect(status.unresolved).toEqual(["MAIN_MEMBER", "SPOUSE", "CHILD", "EXTENDED_FAMILY"])
    expect(status.reason).toBe("Mandatory eligibility rule MAX_COVER is not configured")
  })

  it("names ONLY the life types a scoped-but-incomplete term leaves unresolved", () => {
    // The real defect: a MAX_COVER captured for CHILD alone looks configured on
    // any screen that counts rows, and screens nothing for a main member.
    const rules = [
      ...completeRules().filter((r) => r.ruleType !== "MAX_COVER"),
      rule("MAX_COVER", "CHILD", 10000),
    ]
    const status = statusFor(rules, "MAX_COVER")
    expect(status.unresolved).toEqual(["MAIN_MEMBER", "SPOUSE", "EXTENDED_FAMILY"])
    expect(status.reason).toBe(
      "Mandatory eligibility rule MAX_COVER is not configured for MAIN_MEMBER, SPOUSE, EXTENDED_FAMILY"
    )
  })

  it("counts an ALL_LIVES term as configured for every life type", () => {
    expect(statusFor(completeRules(), "MAX_COVER").unresolved).toEqual([])
  })

  it("treats an INACTIVE row as not configured", () => {
    const rules = [
      ...completeRules().filter((r) => r.ruleType !== "WAITING_PERIOD_DAYS"),
      rule("WAITING_PERIOD_DAYS", "ALL_LIVES", 180, false),
    ]
    expect(statusFor(rules, "WAITING_PERIOD_DAYS").unresolved).toHaveLength(4)
  })

  it("treats a row with no value as not configured", () => {
    const rules = [
      ...completeRules().filter((r) => r.ruleType !== "MIN_ENTRY_AGE"),
      rule("MIN_ENTRY_AGE", "ALL_LIVES", null),
    ]
    expect(statusFor(rules, "MIN_ENTRY_AGE").unresolved).toHaveLength(4)
  })

  it("counts a valueless SCOPED row as unresolved for that life type ALONE, not a pass", () => {
    // Adding configuration must never make the screen weaker: the SPOUSE row
    // wins over ALL_LIVES for spouses and carries no value, so spouses are
    // unresolved while everyone else still resolves through ALL_LIVES.
    const rules = [...completeRules(), rule("MAX_ENTRY_AGE", "SPOUSE", null)]
    const status = statusFor(rules, "MAX_ENTRY_AGE")
    expect(status.unresolved).toEqual(["SPOUSE"])
    expect(status.reason).toBe("Mandatory eligibility rule MAX_ENTRY_AGE is not configured for SPOUSE")
  })

  it("does not treat a NON-mandatory term as making a mandatory one configured", () => {
    const rules = [rule("MIN_COVER", "ALL_LIVES", 5000), rule("COOLING_OFF_DAYS", "ALL_LIVES", 31)]
    expect(mandatoryRuleStatus(rules).every((s) => s.unresolved.length === 4)).toBe(true)
  })

  it("accepts zero as a configured value", () => {
    // A waiting period of zero days is a real insurer term, not an absent one.
    const rules = [
      ...completeRules().filter((r) => r.ruleType !== "WAITING_PERIOD_DAYS"),
      rule("WAITING_PERIOD_DAYS", "ALL_LIVES", 0),
    ]
    expect(statusFor(rules, "WAITING_PERIOD_DAYS").unresolved).toEqual([])
  })
})
