/**
 * The synthetic valuation guide (providers/synthetic.ts): obviously fictional
 * makes and the deal fixtures' TEST models, VAT-inclusive cents. Not a real
 * guide's figures. Line numbers follow the order here, from 2.
 */
import type { GuideRow } from "../types"

export const SYNTHETIC_GUIDE_ROWS: Omit<GuideRow, "lineNumber">[] = [
  { make: "TEST", model: "EX-1", year: 2025, variant: "", tradeCents: 120_000_000, retailCents: 140_000_000 },
  { make: "TEST", model: "EX-1", year: 2025, variant: "Long reach", tradeCents: 125_000_000, retailCents: 146_000_000 },
  { make: "TEST", model: "EX-2", year: 2025, variant: "", tradeCents: 110_000_000, retailCents: 130_000_000 },
  { make: "SYNTHETIC PLANT", model: "Loader 300", year: 2024, variant: "", tradeCents: 95_000_000, retailCents: 112_000_000 },
  { make: "SYNTHETIC MOTORS", model: "Bakkie 2.4", year: 2023, variant: "Double cab", tradeCents: 38_000_000, retailCents: 44_500_000 },
]
