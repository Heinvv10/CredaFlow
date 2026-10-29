import { describe, expect, it } from "vitest"
import { facts } from "./facts.test-helpers"
import { summarise, type SimulationEntry } from "./simulate-summary"
import type { DecisionKind, RuleDef, Verdict } from "./types"

const rule = (id: string, outcome: RuleDef["outcome"] = "REFER"): RuleDef => ({ id, name: id.toUpperCase(), outcome, reasonCode: id.toUpperCase().replaceAll("-", "_"), when: { field: "bureauScore", op: "lt", value: 1 } })
const verdict = (decision: DecisionKind, over: Partial<Verdict> = {}): Verdict => ({
  decision, reasonCodes: ["X"], declineCategory: null, riskGrade: null, score: null, pricingTier: null, limitCapCents: null, hits: [], ...over,
})
const hit = (id: string) => ({ ruleId: id, name: id, outcome: "REFER" as const, reasonCode: id.toUpperCase() })
const entry = (live: Verdict | null, candidate: Verdict, actual: SimulationEntry["actual"] = "OPEN"): SimulationEntry => ({ facts: facts(), live, candidate, actual })

describe("summarise", () => {
  const rules = [rule("a"), rule("b")]

  it("counts verdicts of the live version and of the candidate", () => {
    const r = summarise([
      entry(verdict("APPROVE"), verdict("APPROVE")), entry(verdict("APPROVE"), verdict("DECLINE")), entry(verdict("REFER"), verdict("DECLINE")),
    ], rules)
    expect(r.sampled).toBe(3)
    expect(r.live).toEqual({ APPROVE: 2, DECLINE: 0, REFER: 1 })
    expect(r.candidate).toEqual({ APPROVE: 1, DECLINE: 2, REFER: 0 })
  })

  it("lists what changed between live and candidate, and counts the unchanged", () => {
    const r = summarise([
      entry(verdict("APPROVE"), verdict("APPROVE")), entry(verdict("APPROVE"), verdict("DECLINE")), entry(verdict("APPROVE"), verdict("DECLINE")), entry(verdict("DECLINE"), verdict("REFER")),
    ], rules)
    expect(r.unchanged).toBe(1)
    expect(r.changes).toEqual([
      { from: "APPROVE", to: "DECLINE", count: 2 },
      { from: "DECLINE", to: "REFER", count: 1 },
    ])
  })

  it("with no live rules everything counts as changed from none", () => {
    const r = summarise([entry(null, verdict("APPROVE"))], rules)
    expect(r.live).toBeNull()
    expect(r.changes).toEqual([{ from: "NONE", to: "APPROVE", count: 1 }])
  })

  it("reports each rule's hit count and hit rate, including a rule that never fires", () => {
    const r = summarise([
      entry(null, verdict("REFER", { hits: [hit("a")] })), entry(null, verdict("REFER", { hits: [hit("a"), hit("b")] })), entry(null, verdict("APPROVE")), entry(null, verdict("APPROVE")),
    ], rules)
    expect(r.ruleHits).toEqual([
      { ruleId: "a", name: "A", outcome: "REFER", hits: 2, hitRatePct: 50 },
      { ruleId: "b", name: "B", outcome: "REFER", hits: 1, hitRatePct: 25 },
    ])
  })

  it("counts applications per risk grade, with the ungraded apart", () => {
    const r = summarise([entry(null, verdict("APPROVE", { riskGrade: "A" })), entry(null, verdict("APPROVE", { riskGrade: "A" })), entry(null, verdict("REFER", { riskGrade: "C" })), entry(null, verdict("APPROVE"))], rules)
    expect(r.byGrade).toEqual({ A: 2, C: 1, UNGRADED: 1 })
  })

  it("sets the candidate against what staff actually decided", () => {
    const r = summarise([
      entry(null, verdict("DECLINE"), "APPROVED"), entry(null, verdict("DECLINE"), "APPROVED"), entry(null, verdict("APPROVE"), "APPROVED"),
      entry(null, verdict("APPROVE"), "DECLINED"), entry(null, verdict("APPROVE"), "OPEN"),
    ], rules)
    expect(r.againstStaff).toEqual({ approvedByStaff: 3, candidateWouldDecline: 2, declinedByStaff: 1, candidateWouldApprove: 1 })
  })

  it("an empty sample reports zeros, not NaN", () => {
    const r = summarise([], rules)
    expect(r.sampled).toBe(0)
    expect(r.ruleHits.every((h) => h.hitRatePct === 0)).toBe(true)
    expect(r.withBureau).toBe(0)
  })
})
