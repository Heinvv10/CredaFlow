// A stored AssetFinanceDeal's structure as solver terms (./deal-input.ts),
// and its indicative schedule solved at today's reference rates
// (./deal-structure.ts). Pure apart from the reference-rate read.
import type { MaintenanceRiskModel, Prisma, ReferenceRateBasis, RentalTiming, UsageUnit } from "@prisma/client"
import { STRUCTURE_PRESETS, type StructurePresetName, type StructureTerms } from "./deal-input"
import { solveWithRate, type AssetPrice, type Solved } from "./deal-structure"
import { isoOfDbDate } from "./dates"
import type { RatesDb } from "./rates-store"
import type { LeaseTerms } from "./lease-input"

/**
 * A lease deal's columns: rentalTiming is set exactly on a lease, the
 * maintenance columns exactly on a full-maintenance lease
 * (AssetFinanceDeal_lease_terms_shape).
 */
export interface StoredLeaseColumns {
  rentalTiming: RentalTiming | null
  escalationRate: Prisma.Decimal | null
  maintenanceMonthlyExclVatCents: number | null
  maintenanceEscalationRate: Prisma.Decimal | null
  maintenanceRiskModel: MaintenanceRiskModel | null
  usageAllowancePerYear: number | null
  usageUnit: UsageUnit | null
  excessRateCents: number | null
  earlyTerminationPenaltyRate: Prisma.Decimal | null
}

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
  rentalTiming: true,
  escalationRate: true,
  maintenanceMonthlyExclVatCents: true,
  maintenanceEscalationRate: true,
  maintenanceRiskModel: true,
  usageAllowancePerYear: true,
  usageUnit: true,
  excessRateCents: true,
  earlyTerminationPenaltyRate: true,
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

/** The lease terms of a stored lease deal; null for any other contract type. */
export function leaseTermsFromDeal(deal: StoredLeaseColumns): LeaseTerms | null {
  const { rentalTiming, escalationRate, earlyTerminationPenaltyRate: penalty } = deal
  if (rentalTiming === null) return null
  if (escalationRate === null || penalty === null) {
    throw new TypeError("A lease deal must carry its rental timing, escalation and penalty (AssetFinanceDeal_lease_terms_shape)")
  }
  const maintenance = deal.maintenanceMonthlyExclVatCents !== null && deal.maintenanceEscalationRate !== null && deal.maintenanceRiskModel !== null
    ? { monthlyExclVatCents: deal.maintenanceMonthlyExclVatCents, escalationRate: deal.maintenanceEscalationRate.toString(), riskModel: deal.maintenanceRiskModel }
    : null
  const usage = deal.usageAllowancePerYear !== null && deal.usageUnit !== null && deal.excessRateCents !== null
    ? { allowancePerYear: deal.usageAllowancePerYear, unit: deal.usageUnit, excessRateCents: deal.excessRateCents }
    : null
  return { rentalTiming, escalationRate: escalationRate.toString(), earlyTerminationPenaltyRate: penalty.toString(), maintenance, usage }
}

export function termsFromDeal(deal: StoredDealStructure & Partial<StoredLeaseColumns>): StructureTerms {
  const lease = deal.rentalTiming === undefined ? null : leaseTermsFromDeal(deal as StoredDealStructure & StoredLeaseColumns)
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
    ...(lease ? { lease } : {}),
  }
}

export function solveStoredDeal(
  db: RatesDb,
  tenantId: string,
  deal: StoredDealStructure & Partial<StoredLeaseColumns>,
  asset: AssetPrice,
): Promise<Solved> {
  return solveWithRate(db, tenantId, asset, termsFromDeal(deal))
}
