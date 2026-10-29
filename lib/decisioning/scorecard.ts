import type { DecisionFacts } from "./facts"
import type { Characteristic, GradeBand, Scalar, Scorecard, ScorecardBin, ScoreResult } from "./types"

function inBin(bin: ScorecardBin, fact: Scalar): boolean {
  if (bin.equals !== undefined) return fact === bin.equals
  if (bin.in !== undefined) return bin.in.includes(fact)
  if (typeof fact !== "number") return false
  return (bin.min === undefined || fact >= bin.min) && (bin.max === undefined || fact < bin.max)
}

function pointsFor(characteristic: Characteristic, facts: DecisionFacts): number {
  const fact = facts[characteristic.field]
  if (fact === null) return characteristic.missingPoints
  const bin = characteristic.bins.find((candidate) => inBin(candidate, fact))
  return bin ? bin.points : characteristic.missingPoints
}

/** The highest band whose minimum the score reaches; the lowest band takes everything below. */
export function bandFor(bands: readonly GradeBand[], score: number): GradeBand {
  return bands.find((band) => score >= band.minScore) ?? bands[bands.length - 1]
}

/** Base score plus the points of the bin each characteristic falls in, mapped to a grade band. Pure. */
export function scoreApplication(card: Scorecard, facts: DecisionFacts): ScoreResult {
  const breakdown = card.characteristics.map((c) => ({ field: c.field, points: pointsFor(c, facts) }))
  const score = card.baseScore + breakdown.reduce((sum, row) => sum + row.points, 0)
  const band = bandFor(card.bands, score)
  return {
    score,
    grade: band.grade,
    rank: Math.max(0, card.bands.indexOf(band)),
    action: band.action,
    pricingTier: band.pricingTier ?? null,
    declineCategory: band.declineCategory ?? null,
    breakdown,
  }
}
