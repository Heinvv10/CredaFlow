import { describe, expect, it } from "vitest"
import { evaluateBureauGate } from "@/lib/decision/bureau-gate"
import { bureauBlockCode, type BureauFacts } from "./bureau-code"

const clean: BureauFacts = {
  score: 640,
  unscoreable: false,
  hasAdverse: false,
  deceased: false,
  underDebtReview: false,
  hasJudgement: false,
  hasNotice: false,
  obligations: { totalMonthly: 100000 },
  provider: "experian",
}
const cfg = { bureauMinScore: 600, bureauBlockAdverse: true }

const cases: Array<[string, Partial<BureauFacts>, Partial<typeof cfg>, string | null]> = [
  ["a clean report", {}, {}, null],
  ["deceased", { deceased: true }, {}, "DECEASED"],
  ["debt review before a judgement", { underDebtReview: true, hasJudgement: true }, {}, "DEBT_REVIEW"],
  ["a judgement", { hasJudgement: true }, {}, "JUDGEMENT"],
  ["a notice", { hasNotice: true }, {}, "NOTICE"],
  ["adverse, blocked by the tenant", { hasAdverse: true }, {}, "ADVERSE"],
  ["adverse, allowed by the tenant", { hasAdverse: true }, { bureauBlockAdverse: false }, null],
  ["no obligations stated", { obligations: {} }, {}, "OBLIGATIONS_UNKNOWN"],
  ["a floor below the Sigma band", {}, { bureauMinScore: 300 }, "UNCALIBRATED"],
  ["unscoreable", { unscoreable: true }, {}, "UNSCOREABLE"],
  ["no score", { score: null }, {}, "UNSCOREABLE"],
  ["below the minimum", { score: 599 }, {}, "BELOW_MIN_SCORE"],
  ["at the minimum", { score: 600 }, {}, null],
]

describe("bureauBlockCode agrees with the bureau gate", () => {
  it.each(cases)("%s", (_name, check, config, code) => {
    const facts = { ...clean, ...check }
    const settings = { ...cfg, ...config }
    expect(bureauBlockCode(facts, settings)).toBe(code)
    expect(evaluateBureauGate(facts, settings).blocked).toBe(code !== null)
  })

  it("a simulated check: blocked by both exactly where this deployment forbids simulation", () => {
    const facts = { ...clean, provider: "simulated" }
    const code = bureauBlockCode(facts, cfg)
    expect(code === null || code === "SIMULATED").toBe(true)
    expect(evaluateBureauGate(facts, cfg).blocked).toBe(code !== null)
  })
})
