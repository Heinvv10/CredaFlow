import { describe, expect, it } from "vitest"
import { FACT_DEFINITIONS, FACT_NAMES } from "@/lib/decisioning/facts"
import { parseScorecard } from "@/lib/decisioning/validate-scorecard"
import { defaultBin, emptyScorecard, newCharacteristic, nextCharacteristicFact } from "./scorecard-defaults"
import type { FactOption } from "./types"

const facts: FactOption[] = FACT_NAMES.map((name) => ({ name, ...FACT_DEFINITIONS[name] }))
const fact = (name: string) => facts.find((f) => f.name === name)!

describe("scorecard defaults", () => {
  it("a bin fits the fact's type: a range for a number, a yes for a yes/no, the first listed value for a list", () => {
    expect(defaultBin(fact("bureauScore"))).toEqual({ min: 0, points: 0 })
    expect(defaultBin(fact("isRepeatClient"))).toEqual({ equals: true, points: 0 })
    expect(defaultBin(fact("employmentStatus"))).toEqual({ equals: "EMPLOYED", points: 0 })
  })

  it("every fact's default characteristic is a valid one (the server accepts a card holding it)", () => {
    for (const f of facts) {
      const card = { baseScore: 0, characteristics: [newCharacteristic(f)], bands: [{ minScore: 0, grade: "A", action: "ALLOW" }] }
      expect(() => parseScorecard(card), f.name).not.toThrow()
    }
  })

  it("the next characteristic is the first number fact not already used", () => {
    expect(nextCharacteristicFact(facts, []).type).toBe("number")
    const used = facts.filter((f) => f.type === "number").map((f) => f.name)
    expect(nextCharacteristicFact(facts, used.slice(0, 3)).name).toBe(used[3])
    expect(nextCharacteristicFact(facts, used).type).not.toBe("number")
  })

  it("a new scorecard starts on the bureau score with a valid card", () => {
    const card = emptyScorecard(facts)
    expect(card.characteristics[0].field).toBe("bureauScore")
    expect(() => parseScorecard(card)).not.toThrow()
  })
})
