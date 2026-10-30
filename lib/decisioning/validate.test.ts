import { describe, expect, it } from "vitest"
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { parseRules } from "./validate-rules"
import { parseScorecard } from "./validate-scorecard"

const ok = {
  id: "judgement", name: "Court judgement", outcome: "KNOCK_OUT", reasonCode: "BUREAU_JUDGEMENT", declineCategory: "ADVERSE_LISTING",
  when: { field: "bureauJudgement", op: "eq", value: true },
}

function problems(fn: () => unknown): string[] {
  try {
    fn()
  } catch (error) {
    if (error instanceof InvalidPayloadError) return [...error.problems]
    throw error
  }
  throw new Error("expected InvalidPayloadError")
}

describe("parseRules", () => {
  it("accepts a well-formed set and returns it unchanged", () => {
    expect(parseRules([ok])).toEqual([ok])
  })

  it("accepts nested groups, between, in and isNull", () => {
    const set = [{
      id: "r", name: "R", outcome: "REFER", reasonCode: "R_CODE",
      when: { any: [
        { all: [{ field: "ageYears", op: "between", value: [18, 21] }, { field: "employmentStatus", op: "in", value: ["STUDENT", "UNEMPLOYED"] }] },
        { field: "bureauScore", op: "isNull" },
      ] },
    }]
    expect(parseRules(set)).toEqual(set)
  })

  it.each([
    ["a non-array", {}, /array/],
    ["an unknown field", [{ ...ok, when: { field: "shoeSize", op: "eq", value: 1 } }], /unknown fact "shoeSize"/],
    ["an operator the fact's type does not take", [{ ...ok, when: { field: "bureauJudgement", op: "gt", value: 1 } }], /operator "gt"/],
    ["a value of the wrong type", [{ ...ok, when: { field: "bureauScore", op: "lt", value: "high" } }], /number/],
    ["a string outside the fact's list", [{ ...ok, when: { field: "employmentStatus", op: "eq", value: "RETIRED" } }], /one of/],
    ["between without two numbers", [{ ...ok, when: { field: "ageYears", op: "between", value: [18] } }], /two numbers/],
    ["between with low above high", [{ ...ok, when: { field: "ageYears", op: "between", value: [30, 20] } }], /low/],
    ["an empty group", [{ ...ok, when: { all: [] } }], /at least one/],
    ["a group with both all and any", [{ ...ok, when: { all: [{ field: "bureauJudgement", op: "eq", value: true }], any: [] } }], /exactly one/],
    ["a knock-out with no decline category", [{ ...ok, declineCategory: undefined }], /declineCategory/],
    ["a knock-out category with no client wording", [{ ...ok, declineCategory: "OTHER" }], /declineCategory/],
    ["a limit cap with no cap", [{ ...ok, outcome: "LIMIT_CAP", declineCategory: undefined }], /limitCapCents/],
    ["a refer rule carrying a cap", [{ ...ok, outcome: "REFER", declineCategory: undefined, limitCapCents: 5 }], /limitCapCents/],
    ["a lower-case reason code", [{ ...ok, reasonCode: "judgement" }], /reasonCode/],
    ["a reason code the engine reserves", [{ ...ok, reasonCode: "RULES_PASSED" }], /reserved/],
    ["a duplicate id", [ok, ok], /duplicate/],
    ["an unknown key", [{ ...ok, secret: 1 }], /unknown key "secret"/],
    ["a too-deep tree", [{ ...ok, when: { all: [{ all: [{ all: [{ all: [{ all: [{ all: [{ field: "bureauJudgement", op: "eq", value: true }] }] }] }] }] }] } }], /nested/],
  ])("rejects %s", (_name, input, message) => {
    expect(problems(() => parseRules(input)).join("\n")).toMatch(message)
  })

  it("reports every problem, with the rule it is in", () => {
    const list = problems(() => parseRules([{ ...ok, reasonCode: "x" }, { ...ok, id: "second", when: { field: "nope", op: "eq", value: 1 } }]))
    expect(list.length).toBe(2)
    expect(list[0]).toContain("rules[0]")
    expect(list[1]).toContain("rules[1]")
  })
})

const card = {
  baseScore: 100,
  characteristics: [{ field: "bureauScore", missingPoints: -10, bins: [{ max: 500, points: -20 }, { min: 500, points: 40 }] }],
  bands: [{ minScore: 100, grade: "A", action: "ALLOW", pricingTier: "PRIME" }, { minScore: 0, grade: "B", action: "DECLINE", declineCategory: "BUREAU_SCORE" }],
}

describe("parseScorecard", () => {
  it("accepts a card and returns it unchanged; null stays null", () => {
    expect(parseScorecard(card)).toEqual(card)
    expect(parseScorecard(null)).toBeNull()
  })

  it.each([
    ["no bands", { ...card, bands: [] }, /band/],
    ["bands not strictly descending", { ...card, bands: [{ minScore: 0, grade: "A", action: "ALLOW" }, { minScore: 100, grade: "B", action: "ALLOW" }] }, /descending/],
    ["a repeated grade", { ...card, bands: [{ minScore: 100, grade: "A", action: "ALLOW" }, { minScore: 0, grade: "A", action: "ALLOW" }] }, /grade "A" is repeated/],
    ["a malformed grade", { ...card, bands: [{ minScore: 0, grade: "excellent", action: "ALLOW" }] }, /grade/],
    ["a decline category on an allow band", { ...card, bands: [{ minScore: 0, grade: "A", action: "ALLOW", declineCategory: "POLICY" }] }, /declineCategory/],
    ["an unknown characteristic", { ...card, characteristics: [{ field: "x", missingPoints: 0, bins: [{ min: 0, points: 1 }] }] }, /unknown fact/],
    ["a repeated characteristic", { ...card, characteristics: [card.characteristics[0], card.characteristics[0]] }, /repeated/],
    ["a bin with no test", { ...card, characteristics: [{ field: "bureauScore", missingPoints: 0, bins: [{ points: 5 }] }] }, /bin/],
    ["a min above its max", { ...card, characteristics: [{ field: "bureauScore", missingPoints: 0, bins: [{ min: 9, max: 3, points: 5 }] }] }, /min/],
    ["a numeric range on a text fact", { ...card, characteristics: [{ field: "employmentStatus", missingPoints: 0, bins: [{ min: 1, points: 5 }] }] }, /number/],
    ["a fractional point value", { ...card, characteristics: [{ field: "bureauScore", missingPoints: 0, bins: [{ min: 1, points: 1.5 }] }] }, /whole/],
  ])("rejects %s", (_name, input, message) => {
    expect(problems(() => parseScorecard(input)).join("\n")).toMatch(message)
  })
})
