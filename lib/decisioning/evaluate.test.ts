import { describe, expect, it } from "vitest"
import { evaluateRules } from "./evaluate"
import { facts } from "./facts.test-helpers"
import type { Node, RuleDef } from "./types"

const rule = (when: Node, over: Partial<RuleDef> = {}): RuleDef => ({
  id: "r1", name: "R1", outcome: "REFER", reasonCode: "R_ONE", when, ...over,
})

describe("evaluateRules", () => {
  it("fires a rule whose condition holds and none whose condition fails", () => {
    const hits = evaluateRules([
      rule({ field: "bureauScore", op: "lt", value: 700 }, { id: "low", reasonCode: "LOW" }),
      rule({ field: "bureauScore", op: "lt", value: 500 }, { id: "very-low", reasonCode: "VERY_LOW" }),
    ], facts({ bureauScore: 640 }))
    expect(hits.map((h) => h.ruleId)).toEqual(["low"])
  })

  it.each([
    ["eq", 640, true], ["eq", 641, false], ["neq", 641, true], ["gt", 639, true], ["gt", 640, false],
    ["gte", 640, true], ["lt", 641, true], ["lt", 640, false], ["lte", 640, true],
  ] as const)("number operator %s %s -> %s", (op, value, fires) => {
    expect(evaluateRules([rule({ field: "bureauScore", op, value })], facts({ bureauScore: 640 })).length).toBe(fires ? 1 : 0)
  })

  it("between is inclusive at both ends", () => {
    const r = rule({ field: "ageYears", op: "between", value: [18, 65] })
    expect(evaluateRules([r], facts({ ageYears: 18 }))).toHaveLength(1)
    expect(evaluateRules([r], facts({ ageYears: 65 }))).toHaveLength(1)
    expect(evaluateRules([r], facts({ ageYears: 17 }))).toHaveLength(0)
    expect(evaluateRules([r], facts({ ageYears: 66 }))).toHaveLength(0)
  })

  it("in and notIn match strings", () => {
    const f = facts({ employmentStatus: "STUDENT" })
    expect(evaluateRules([rule({ field: "employmentStatus", op: "in", value: ["STUDENT", "UNEMPLOYED"] })], f)).toHaveLength(1)
    expect(evaluateRules([rule({ field: "employmentStatus", op: "notIn", value: ["STUDENT", "UNEMPLOYED"] })], f)).toHaveLength(0)
  })

  it("a missing fact fires nothing except isNull", () => {
    const f = facts({ bureauScore: null })
    expect(evaluateRules([rule({ field: "bureauScore", op: "lt", value: 500 })], f)).toHaveLength(0)
    expect(evaluateRules([rule({ field: "bureauScore", op: "neq", value: 500 })], f)).toHaveLength(0)
    expect(evaluateRules([rule({ field: "bureauScore", op: "gte", value: 0 })], f)).toHaveLength(0)
    expect(evaluateRules([rule({ field: "bureauScore", op: "isNull" })], f)).toHaveLength(1)
    expect(evaluateRules([rule({ field: "bureauScore", op: "notNull" })], f)).toHaveLength(0)
  })

  it("all is AND, any is OR, and groups nest", () => {
    const f = facts({ ageYears: 20, bureauScore: 560, employmentStatus: "EMPLOYED" })
    const tree: Node = {
      all: [
        { field: "ageYears", op: "lt", value: 25 },
        { any: [{ field: "bureauScore", op: "lt", value: 500 }, { field: "employmentStatus", op: "eq", value: "EMPLOYED" }] },
      ],
    }
    expect(evaluateRules([rule(tree)], f)).toHaveLength(1)
    expect(evaluateRules([rule(tree)], facts({ ageYears: 30, bureauScore: 560 }))).toHaveLength(0)
    expect(evaluateRules([rule(tree)], facts({ ageYears: 20, bureauScore: 560, employmentStatus: "STUDENT" }))).toHaveLength(0)
  })

  it("carries the outcome, reason code, category and cap of a fired rule", () => {
    const hits = evaluateRules([
      rule({ field: "bureauJudgement", op: "eq", value: true }, { id: "judg", outcome: "KNOCK_OUT", reasonCode: "JUDGEMENT", declineCategory: "ADVERSE_LISTING" }),
      rule({ field: "isRepeatClient", op: "eq", value: false }, { id: "new", outcome: "LIMIT_CAP", reasonCode: "NEW_CLIENT_CAP", limitCapCents: 200_000 }),
    ], facts({ bureauJudgement: true }))
    expect(hits).toEqual([
      { ruleId: "judg", name: "R1", outcome: "KNOCK_OUT", reasonCode: "JUDGEMENT", declineCategory: "ADVERSE_LISTING" },
      { ruleId: "new", name: "R1", outcome: "LIMIT_CAP", reasonCode: "NEW_CLIENT_CAP", limitCapCents: 200_000 },
    ])
  })

  it("a condition on the wrong type of value never fires", () => {
    // A stored set is validated, but a bad one must still fail closed (no hit, no throw).
    expect(evaluateRules([rule({ field: "bureauScore", op: "lt", value: "high" })], facts())).toHaveLength(0)
  })

  it("notIn and in on a missing fact fire nothing: an unknown value is not 'none of the list'", () => {
    const f = facts({ employmentStatus: null })
    expect(evaluateRules([rule({ field: "employmentStatus", op: "notIn", value: ["STUDENT"] })], f)).toHaveLength(0)
    expect(evaluateRules([rule({ field: "employmentStatus", op: "in", value: ["STUDENT"] })], f)).toHaveLength(0)
  })

  it("eq is strict: a number never equals its text, and yes/no never equals 1", () => {
    expect(evaluateRules([rule({ field: "bureauScore", op: "eq", value: "640" })], facts({ bureauScore: 640 }))).toHaveLength(0)
    expect(evaluateRules([rule({ field: "bureauJudgement", op: "eq", value: 1 as never })], facts({ bureauJudgement: true }))).toHaveLength(0)
    expect(evaluateRules([rule({ field: "employmentStatus", op: "neq", value: "employed" })], facts({ employmentStatus: "EMPLOYED" }))).toHaveLength(1)
  })

  it("a bureau flag is missing, not false, without a bureau check: 'no judgement' does not pass an applicant nobody checked", () => {
    const unchecked = facts({ bureauAvailable: false, bureauScore: null, bureauJudgement: null, bureauAdverse: null })
    expect(evaluateRules([rule({ field: "bureauJudgement", op: "eq", value: false })], unchecked)).toHaveLength(0)
    expect(evaluateRules([rule({ field: "bureauJudgement", op: "neq", value: true })], unchecked)).toHaveLength(0)
    expect(evaluateRules([rule({ field: "bureauJudgement", op: "isNull" })], unchecked)).toHaveLength(1)
    expect(evaluateRules([rule({ field: "bureauJudgement", op: "eq", value: false })], facts({ bureauJudgement: false }))).toHaveLength(1)
  })

  it("compares a fractional figure with the exact threshold (no rounding)", () => {
    expect(evaluateRules([rule({ field: "ndiCoverPct", op: "lt", value: 110 })], facts({ ndiCoverPct: 109.99 }))).toHaveLength(1)
    expect(evaluateRules([rule({ field: "ndiCoverPct", op: "lt", value: 110 })], facts({ ndiCoverPct: 110 }))).toHaveLength(0)
  })
})
