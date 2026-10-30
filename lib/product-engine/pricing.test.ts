import { describe, expect, it } from "vitest"
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { parsePricingRule, resolvePricing, type PricingContext, type PricingRule } from "./pricing"

const rule = (over: Partial<PricingRule> & { id: string }): PricingRule => ({
  productId: null, name: over.id, segment: null, channel: null, riskRankMin: null, riskRankMax: null, campaignCode: null,
  validFrom: "2027-01-01", validTo: null, priority: 0, rate: { mode: "SET", value: 0.03 }, initiationFeePct: null, createdAt: "2027-01-01T00:00:00.000Z",
  ...over,
})
const ctx = (over: Partial<PricingContext> = {}): PricingContext => ({ productId: "p1", segment: null, channel: null, riskRank: null, campaignCode: null, asOf: "2027-03-01", ...over })
const base = { ratePm: 0.05, initiationFeePct: 0.1 }

describe("resolvePricing", () => {
  it("prices at the product's own rate when no rule matches", () => {
    expect(resolvePricing([], ctx(), base)).toEqual({ ratePm: 0.05, initiationFeePct: 0.1, ruleId: null, ruleName: null })
  })

  it("applies a rule for a risk grade range: rank 0-1 (the two best bands) get the lower rate, rank 2 does not", () => {
    const rules = [rule({ id: "good", riskRankMin: 0, riskRankMax: 1, rate: { mode: "SET", value: 0.03 } })]
    expect(resolvePricing(rules, ctx({ riskRank: 1 }), base).ratePm).toBe(0.03)
    expect(resolvePricing(rules, ctx({ riskRank: 0 }), base).ratePm).toBe(0.03)
    expect(resolvePricing(rules, ctx({ riskRank: 2 }), base).ratePm).toBe(0.05)
  })

  it("a rule that names a grade never applies to an application that has none: pricing is never guessed", () => {
    expect(resolvePricing([rule({ id: "good", riskRankMin: 0, riskRankMax: 1 })], ctx({ riskRank: null }), base).ruleId).toBeNull()
  })

  it("a rule with a segment, a channel or a campaign applies only to a matching context", () => {
    const rules = [rule({ id: "seg", segment: "SALARIED" }), rule({ id: "chan", channel: "MOBILE", rate: { mode: "SET", value: 0.04 } })]
    expect(resolvePricing(rules, ctx({ segment: "SALARIED" }), base).ruleId).toBe("seg")
    expect(resolvePricing(rules, ctx({ segment: "SME" }), base).ruleId).toBeNull()
    expect(resolvePricing(rules, ctx({ channel: "MOBILE" }), base).ruleId).toBe("chan")
    expect(resolvePricing([rule({ id: "promo", campaignCode: "SPRING27" })], ctx({ campaignCode: "SPRING27" }), base).ruleId).toBe("promo")
    expect(resolvePricing([rule({ id: "promo", campaignCode: "SPRING27" })], ctx({ campaignCode: null }), base).ruleId).toBeNull()
    expect(resolvePricing([rule({ id: "promo", campaignCode: "SPRING27" })], ctx({ campaignCode: "OTHER" }), base).ruleId).toBeNull()
  })

  it("only rules in their validity window: valid from the day it starts, up to and including the day it ends", () => {
    const r = [rule({ id: "promo", validFrom: "2027-03-01", validTo: "2027-03-31" })]
    expect(resolvePricing(r, ctx({ asOf: "2027-02-28" }), base).ruleId).toBeNull()
    expect(resolvePricing(r, ctx({ asOf: "2027-03-01" }), base).ruleId).toBe("promo")
    expect(resolvePricing(r, ctx({ asOf: "2027-03-31" }), base).ruleId).toBe("promo")
    expect(resolvePricing(r, ctx({ asOf: "2027-04-01" }), base).ruleId).toBeNull()
  })

  it("a rule for another product never applies; a rule with no product applies to all", () => {
    expect(resolvePricing([rule({ id: "other", productId: "p2" })], ctx(), base).ruleId).toBeNull()
    expect(resolvePricing([rule({ id: "all" })], ctx(), base).ruleId).toBe("all")
  })

  it("the most specific rule wins (more conditions), then the higher priority, then the newer rule, then the lower id", () => {
    const broad = rule({ id: "broad", rate: { mode: "SET", value: 0.04 } })
    const specific = rule({ id: "specific", segment: "SALARIED", channel: "MOBILE", rate: { mode: "SET", value: 0.02 } })
    expect(resolvePricing([broad, specific], ctx({ segment: "SALARIED", channel: "MOBILE" }), base).ruleId).toBe("specific")
    const a = rule({ id: "a", segment: "SALARIED", priority: 1 })
    const b = rule({ id: "b", segment: "SALARIED", priority: 5 })
    expect(resolvePricing([a, b], ctx({ segment: "SALARIED" }), base).ruleId).toBe("b")
    const older = rule({ id: "older", segment: "SALARIED", createdAt: "2027-01-01T00:00:00.000Z" })
    const newer = rule({ id: "newer", segment: "SALARIED", createdAt: "2027-02-01T00:00:00.000Z" })
    expect(resolvePricing([older, newer], ctx({ segment: "SALARIED" }), base).ruleId).toBe("newer")
    const x = rule({ id: "x", segment: "SALARIED" })
    const y = rule({ id: "y", segment: "SALARIED" })
    expect(resolvePricing([y, x], ctx({ segment: "SALARIED" }), base).ruleId).toBe("x")
  })

  it("rules do not stack: one rule prices the application", () => {
    const rules = [rule({ id: "a", segment: "SALARIED", rate: { mode: "ADD", value: -0.01 } }), rule({ id: "b", channel: "MOBILE", rate: { mode: "ADD", value: -0.01 } })]
    expect(resolvePricing(rules, ctx({ segment: "SALARIED", channel: "MOBILE" }), base).ratePm).toBeCloseTo(0.04, 10)
  })

  it("ADD moves the product's rate (floored at 0); SET replaces it; a fee override replaces the fee share", () => {
    expect(resolvePricing([rule({ id: "add", rate: { mode: "ADD", value: 0.01 } })], ctx(), base).ratePm).toBeCloseTo(0.06, 10)
    expect(resolvePricing([rule({ id: "add", rate: { mode: "ADD", value: -0.2 } })], ctx(), base).ratePm).toBe(0)
    expect(resolvePricing([rule({ id: "fee", initiationFeePct: 0.02 })], ctx(), base).initiationFeePct).toBe(0.02)
    expect(resolvePricing([rule({ id: "nofee" })], ctx(), base).initiationFeePct).toBe(0.1)
  })
})

describe("parsePricingRule", () => {
  const raw = { action: "CREATE", rule: { productId: "p1", name: "Spring salaried", segment: "SALARIED", channel: "DIGITAL", riskRankMin: 0, riskRankMax: 2, campaignCode: "SPRING27", validFrom: "2027-03-01", validTo: "2027-05-31", priority: 10, rate: { mode: "SET", value: 0.025 }, initiationFeePct: 0.03 } }
  const problems = (x: unknown) => {
    try {
      parsePricingRule(x)
      return []
    } catch (e) {
      return (e as InvalidPayloadError).problems
    }
  }

  it("accepts a complete rule and a retirement", () => {
    expect(parsePricingRule(raw)).toMatchObject({ action: "CREATE", rule: { name: "Spring salaried", rate: { mode: "SET", value: 0.025 } } })
    expect(parsePricingRule({ action: "RETIRE", ruleId: "r1" })).toEqual({ action: "RETIRE", ruleId: "r1" })
  })

  it.each([
    ["a rate of 100% a month", { rate: { mode: "SET", value: 1 } }, "rule.rate"],
    ["a negative SET rate", { rate: { mode: "SET", value: -0.01 } }, "rule.rate"],
    ["an unknown mode", { rate: { mode: "MULTIPLY", value: 2 } }, "rule.rate"],
    ["a rank range the wrong way round", { riskRankMin: 3, riskRankMax: 1 }, "rule.riskRankMin"],
    ["only one end of a rank range", { riskRankMin: 1, riskRankMax: null }, "rule.riskRankMin"],
    ["an end date before the start", { validTo: "2027-02-01" }, "rule.validTo"],
    ["a bad date", { validFrom: "01/03/2027" }, "rule.validFrom"],
    ["a priority out of range", { priority: 5000 }, "rule.priority"],
    ["a campaign code that is not UPPER_SNAKE", { campaignCode: "spring 27" }, "rule.campaignCode"],
    ["a fee share over 100%", { initiationFeePct: 2 }, "rule.initiationFeePct"],
    ["no name", { name: "" }, "rule.name"],
  ])("refuses %s", (_label, change, path) => {
    expect(problems({ action: "CREATE", rule: { ...raw.rule, ...change } }).some((p) => p.startsWith(path))).toBe(true)
  })

  it("refuses an unknown action and unknown keys", () => {
    expect(problems({ action: "EDIT" }).length).toBeGreaterThan(0)
    expect(problems({ ...raw, extra: 1 }).length).toBeGreaterThan(0)
  })
})
