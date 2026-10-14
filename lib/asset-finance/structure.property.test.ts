import { describe, expect, it } from "vitest"
import { solveStructure } from "./structure"
import type { RatePoint, StructureInput } from "./types"
import { expectLedgerInvariants, expectMatchesOracle } from "./__tests__/oracle-assertions"

// mulberry32: a small seeded PRNG so every run explores the same 200 structures.
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pad = (n: number): string => String(n).padStart(2, "0")

function randomStructure(rnd: () => number): StructureInput {
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1))
  const pick = <T,>(items: T[]): T => items[Math.floor(rnd() * items.length)]

  const price = int(10_000_000, 500_000_000) // R100k – R5m
  const deposit = Math.round(price * rnd() * 0.3)
  const tradeIn = rnd() < 0.3 ? Math.round(price * rnd() * 0.1) : 0
  const fees = int(0, 500_000)
  const financed = price - deposit - tradeIn + fees
  let balloon = Math.round(price * rnd() * 0.4)
  if (balloon >= financed) balloon = Math.floor(financed * 0.4)

  const term = int(12, 84)
  const weights = Array.from({ length: term }, () => pick([0, 0, 0.5, 1, 1, 1, 1.5, 2, 3]))
  weights[term - 1] = pick([0.5, 1, 2, 3])

  const year = int(2026, 2030)
  const month = int(1, 12)
  const day = Math.min(int(1, 31), new Date(Date.UTC(year, month, 0)).getUTCDate())
  const startDate = `${year}-${pad(month)}-${pad(day)}`
  const startMs = Date.UTC(year, month - 1, day)
  const isoAfter = (days: number): string => new Date(startMs + days * 86_400_000).toISOString().slice(0, 10)

  const rate = (): number => Math.round((0.07 + rnd() * 0.18) * 1e6) / 1e6
  const ratePath: RatePoint[] = [{ effectiveDate: isoAfter(-int(0, 400)), annualRate: rate() }]
  if (rnd() < 0.5) ratePath.push({ effectiveDate: isoAfter(int(1, term * 30)), annualRate: rate() })

  const input: StructureInput = {
    cashPriceCents: price,
    depositCents: deposit,
    tradeInCents: tradeIn,
    financedFeesCents: fees,
    balloonCents: balloon,
    weights,
    startDate,
    ratePath,
  }
  if (rnd() < 0.3) input.firstDueDate = isoAfter(int(15, 60))
  const vat = Math.round((price * 15) / 115)
  if (rnd() < 0.3 && vat < financed - balloon) {
    input.vatDeferralPeriods = { vatCents: vat, periodIndex: int(0, Math.min(5, term - 1)) }
  }
  return input
}

describe("solveStructure property: 200 seeded random structures", () => {
  it("hits the balloon exactly, keeps the ledger identities and agrees with the oracle", () => {
    const rnd = prng(20261013)
    for (let k = 0; k < 200; k++) {
      const input = randomStructure(rnd)
      const result = solveStructure(input)
      expect(result.financedAmountCents).toBe(
        input.cashPriceCents - input.depositCents - input.tradeInCents + input.financedFeesCents,
      )
      expectLedgerInvariants(result, input.balloonCents)
      expectMatchesOracle(input, result)
    }
  }, 60_000)
})
