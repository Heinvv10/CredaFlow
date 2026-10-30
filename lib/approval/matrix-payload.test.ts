import { describe, expect, it } from "vitest"
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { parseMatrixPayload } from "./matrix-payload"

const level = (n: number, over: Record<string, unknown> = {}) => ({ level: n, name: `Level ${n}`, role: ["LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN"][n - 1], slaHours: 24, committee: false, ...over })
const base = () => ({
  name: "Standard matrix", enabled: true, effectiveFrom: "2026-11-01",
  levels: [level(1), level(2), level(3)],
  rules: [{ id: "big", name: "Large loans", when: { amountMinCents: 5_000_000 }, requiredLevels: 3 }],
  defaultRequiredLevels: 1,
})
const problems = (raw: unknown): string => { try { parseMatrixPayload(raw); return "" } catch (e) { return (e as InvalidPayloadError).problems.join(" | ") } }

describe("parseMatrixPayload", () => {
  it("accepts a three-level matrix with an amount rule", () => {
    expect(parseMatrixPayload(base()).levels).toHaveLength(3)
  })
  it("accepts the committee as the last level, a disabled matrix and zero required levels", () => {
    const raw = { ...base(), enabled: false, levels: [level(1), level(2), level(3, { committee: true })], defaultRequiredLevels: 0 }
    expect(parseMatrixPayload(raw).levels[2].committee).toBe(true)
  })
  it.each([
    ["no levels", { levels: [] }, /levels/],
    ["more than five levels", { levels: [1, 2, 3, 4, 5, 6].map((n) => level(n, { role: "ADMIN" })) }, /levels/],
    ["levels that skip a number", { levels: [level(1), level(3)] }, /consecutive/],
    ["a level role that falls as the level rises", { levels: [level(1, { role: "ADMIN" }), level(2, { role: "LOAN_ADMIN" })] }, /not lower/],
    ["a role that cannot approve", { levels: [level(1, { role: "CREDIT_OFFICER" })] }, /role/],
    ["an SLA of zero or over 30 days", { levels: [level(1, { slaHours: 0 })] }, /slaHours/],
    ["a committee that is not the last level", { levels: [level(1, { committee: true }), level(2)] }, /committee/],
    ["two committees", { levels: [level(1), level(2, { committee: true }), level(3, { committee: true })] }, /committee/],
    ["a rule needing more levels than exist", { rules: [{ id: "r", name: "r", when: {}, requiredLevels: 4 }] }, /requiredLevels/],
    ["a default needing more levels than exist", { defaultRequiredLevels: 4 }, /defaultRequiredLevels/],
    ["a repeated rule id", { rules: [{ id: "r", name: "a", when: {}, requiredLevels: 1 }, { id: "r", name: "b", when: {}, requiredLevels: 1 }] }, /repeated/],
    ["an amount range that is back to front", { rules: [{ id: "r", name: "r", when: { amountMinCents: 10, amountMaxCents: 5 }, requiredLevels: 1 }] }, /amountMinCents/],
    ["a negative or fractional amount", { rules: [{ id: "r", name: "r", when: { amountMinCents: -1 }, requiredLevels: 1 }] }, /amountMinCents/],
    ["an unknown condition", { rules: [{ id: "r", name: "r", when: { colour: "red" }, requiredLevels: 1 }] }, /unknown key/],
    ["an unknown key", { surprise: 1 }, /unknown key/],
    ["a date that is not a day", { effectiveFrom: "next week" }, /effectiveFrom/],
  ])("rejects %s", (_name, over, re) => {
    expect(problems({ ...base(), ...over })).toMatch(re)
  })
})
