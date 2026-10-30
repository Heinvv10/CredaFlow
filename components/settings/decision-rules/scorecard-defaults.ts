import type { Characteristic, Scalar, Scorecard, ScorecardBin } from "@/lib/decisioning/types"
import type { FactOption } from "./types"

/** A bin that fits the fact's type: a range for a number, a value test for the rest. */
export function defaultBin(fact: FactOption, points = 0): ScorecardBin {
  if (fact.type === "number") return { min: 0, points }
  if (fact.type === "boolean") return { equals: true, points }
  return { equals: fact.values?.[0] ?? "", points }
}

/** A new characteristic for a fact, with a bin that fits it. */
export function newCharacteristic(fact: FactOption): Characteristic {
  return { field: fact.name, missingPoints: 0, bins: [defaultBin(fact)] }
}

/** The first number fact no characteristic uses yet (scorecards mostly score numbers); else the first fact. */
export function nextCharacteristicFact(facts: FactOption[], used: readonly string[]): FactOption {
  return facts.find((f) => f.type === "number" && !used.includes(f.name)) ?? facts.find((f) => !used.includes(f.name)) ?? facts[0]
}

export function emptyScorecard(facts: FactOption[]): Scorecard {
  const fact = facts.find((f) => f.name === "bureauScore") ?? nextCharacteristicFact(facts, [])
  return {
    baseScore: 0,
    characteristics: [newCharacteristic(fact)],
    bands: [{ minScore: 100, grade: "A", action: "ALLOW" }, { minScore: 0, grade: "B", action: "REFER" }],
  }
}

/** One bin's test as the type of value it compares, from the text a person typed. */
export function scalarFor(fact: FactOption, text: string): Scalar {
  return fact.type === "number" ? Number(text) : fact.type === "boolean" ? text === "true" : text
}
