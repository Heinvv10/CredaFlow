// A stored AssetFinanceDeal's structure as solver terms (./deal-input.ts),
// and its indicative schedule solved at today's reference rates
// (./deal-structure.ts). Pure apart from the reference-rate read.
import type { Prisma, ReferenceRateBasis } from "@prisma/client"
import { STRUCTURE_PRESETS, type StructurePresetName, type StructureTerms } from "./deal-input"
import { solveWithRate, type AssetPrice, type Solved } from "./deal-structure"
import { isoOfDbDate, type RatesDb } from "./rates-store"

export interface StoredDealStructure {
  depositCents: number
  tradeInCents: number
  financedFeesCents: number
  balloonCents: number
  weights: Prisma.JsonValue
  structurePreset: string
  firstDueDate: Date
  vatDeferralPeriodIndex: number | null
  rateBasis: ReferenceRateBasis
  rateMargin: Prisma.Decimal | null
  fixedRate: Prisma.Decimal | null
}

export const DEAL_STRUCTURE_SELECT = {
  depositCents: true,
  tradeInCents: true,
  financedFeesCents: true,
  balloonCents: true,
  weights: true,
  structurePreset: true,
  firstDueDate: true,
  vatDeferralPeriodIndex: true,
  rateBasis: true,
  rateMargin: true,
  fixedRate: true,
} as const

function storedWeights(value: Prisma.JsonValue): number[] {
  if (!Array.isArray(value) || value.some((w) => typeof w !== "number")) {
    throw new TypeError("AssetFinanceDeal.weights must be a JSON array of numbers")
  }
  return value as number[]
}

export function termsFromDeal(deal: StoredDealStructure): StructureTerms {
  const preset = STRUCTURE_PRESETS.find((p) => p === deal.structurePreset)
  if (!preset) throw new TypeError(`AssetFinanceDeal.structurePreset ${deal.structurePreset} is not a known preset`)
  return {
    depositCents: deal.depositCents,
    tradeInCents: deal.tradeInCents,
    financedFeesCents: deal.financedFeesCents,
    balloonCents: deal.balloonCents,
    preset: preset satisfies StructurePresetName,
    weights: storedWeights(deal.weights),
    firstDueDate: isoOfDbDate(deal.firstDueDate),
    vatDeferralPeriodIndex: deal.vatDeferralPeriodIndex,
    rate: {
      basis: deal.rateBasis,
      margin: deal.rateMargin?.toString() ?? null,
      fixedRate: deal.fixedRate?.toString() ?? null,
    },
  }
}

export function solveStoredDeal(
  db: RatesDb,
  tenantId: string,
  deal: StoredDealStructure,
  asset: AssetPrice,
): Promise<Solved> {
  return solveWithRate(db, tenantId, asset, termsFromDeal(deal))
}
