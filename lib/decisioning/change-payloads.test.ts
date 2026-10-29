import { describe, expect, it } from "vitest"
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { parseEngineConfigPayload, parseRuleSetPayload } from "./change-payloads"

const rule = { id: "r", name: "R", outcome: "REFER", reasonCode: "R_CODE", when: { field: "bureauScore", op: "lt", value: 500 } }
const ruleSet = { productId: null, name: "Baseline", effectiveFrom: "2026-11-01", challengerOnly: false, rules: [rule], scorecard: null }
const engine = { mode: "SHADOW", channels: ["PORTAL"], productIds: ["p1"], delegateUserId: null, repaymentMethod: "EFT", challengerVersionId: null, challengerPercent: 0 }
const problems = (fn: () => unknown) => { try { fn() } catch (e) { if (e instanceof InvalidPayloadError) return e.problems.join("\n") } return "" }

describe("parseRuleSetPayload", () => {
  it("accepts a set", () => expect(parseRuleSetPayload(ruleSet)).toEqual(ruleSet))
  it.each([
    ["an impossible date", { ...ruleSet, effectiveFrom: "2026-02-31" }, /effectiveFrom/],
    ["a malformed date", { ...ruleSet, effectiveFrom: "tomorrow" }, /effectiveFrom/],
    ["an empty set", { ...ruleSet, rules: [] }, /at least one rule/],
    ["an unknown key", { ...ruleSet, extra: 1 }, /unknown key "extra"/],
    ["a padded name", { ...ruleSet, name: " x " }, /name/],
    ["an invalid rule inside", { ...ruleSet, rules: [{ ...rule, reasonCode: "x" }] }, /rules\[0\]/],
  ])("rejects %s", (_n, input, re) => expect(problems(() => parseRuleSetPayload(input))).toMatch(re))
  it("accepts a scorecard alone", () => {
    const card = { baseScore: 0, characteristics: [{ field: "bureauScore", missingPoints: 0, bins: [{ min: 0, points: 1 }] }], bands: [{ minScore: 0, grade: "A", action: "ALLOW" }] }
    expect(parseRuleSetPayload({ ...ruleSet, rules: [], scorecard: card }).scorecard).toEqual(card)
  })
})

describe("parseEngineConfigPayload", () => {
  it("accepts off, shadow and a full live config", () => {
    expect(parseEngineConfigPayload({ ...engine, mode: "OFF", channels: [], productIds: [] }).mode).toBe("OFF")
    expect(parseEngineConfigPayload(engine).mode).toBe("SHADOW")
    expect(parseEngineConfigPayload({ ...engine, mode: "LIVE", delegateUserId: "u1", challengerVersionId: "v1", challengerPercent: 50 }).challengerPercent).toBe(50)
  })
  it.each([
    ["live with no delegate", { ...engine, mode: "LIVE" }, /named staff user/],
    ["shadow with nothing selected", { ...engine, channels: [] }, /at least one channel/],
    ["a challenger share with no challenger", { ...engine, challengerPercent: 10 }, /challenger version/],
    ["a share above 50", { ...engine, challengerPercent: 51 }, /0 to 50/],
    ["an unknown channel", { ...engine, channels: ["SMS"] }, /channels/],
    ["an unknown mode", { ...engine, mode: "AUTO" }, /mode/],
    ["a repeated product", { ...engine, productIds: ["p1", "p1"] }, /productIds/],
  ])("rejects %s", (_n, input, re) => expect(problems(() => parseEngineConfigPayload(input))).toMatch(re))
})
