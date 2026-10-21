/**
 * The book revaluation (docs/asset-finance/SLICE5.md part C, deviation 5):
 * each live asset-finance loan's asset against the current guides. It reads
 * and never writes; a dated GUIDE valuation is recorded on the deal or asset
 * page. The loader is ./revaluation-store.ts, whose SQL does the matching
 * with PostgreSQL lower() (one fold everywhere: ./case-fold.ts); this picks
 * the row per loan and computes the figures.
 */
import type { ContractType } from "@prisma/client"
import { ltvBps } from "./ltv"

/** A current guide row matching a loan's asset, as the loader's SQL matched it (PostgreSQL lower(), as the lookups do). */
export interface CurrentGuideRow {
  assetId: string
  guideId: string
  guideName: string
  effectiveOn: string
  simulated: boolean
  rowId: string
  make: string
  model: string
  year: number
  variant: string
  tradeCents: number
  retailCents: number
  /** The guide name and variant of the asset's newest GUIDE valuation are this row's. */
  recordedVariant: boolean
  /** The trade value of the asset's newest GUIDE valuation, or null without one. */
  lastTradeCents: number | null
}

export interface RevaluationLoan {
  loanId: string
  reference: string
  contractType: ContractType
  /** Loan.outstandingPrincipal: for an instalment sale its principal (no interest, fees or arrears); for a lease its remaining rentals incl. VAT. */
  outstandingCents: number
  asset: { id: string; make: string; model: string; year: number; serialNumber: string }
}

export type RevaluationMatch =
  | {
      kind: "matched"
      /** recorded_variant: the variant of the last GUIDE valuation, in the guide of that name; only_row: the one row that matches. */
      basis: "recorded_variant" | "only_row"
      row: CurrentGuideRow
      /** Outstanding principal ÷ trade; null for a lease (its balance is rentals, not capital). */
      ltvBps: number | null
      /** Trade now less trade at the last GUIDE valuation. */
      changeCents: number | null
    }
  | { kind: "ambiguous"; count: number }
  | { kind: "none" }

export type RevaluationRow = RevaluationLoan & { match: RevaluationMatch }

const LEASES: readonly ContractType[] = ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"]

/** What a loan's outstanding figure is: the report labels it per row. */
export const outstandingBasis = (contractType: ContractType) => (LEASES.includes(contractType) ? "remaining rentals incl. VAT" : "principal")

function matchLoan(loan: RevaluationLoan, rows: CurrentGuideRow[]): RevaluationMatch {
  const candidates = rows.filter((r) => r.assetId === loan.asset.id)
  const recorded = candidates.find((r) => r.recordedVariant)
  const row = recorded ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (!row) return candidates.length > 1 ? { kind: "ambiguous", count: candidates.length } : { kind: "none" }
  return {
    kind: "matched",
    basis: recorded ? "recorded_variant" : "only_row",
    row,
    ltvBps: LEASES.includes(loan.contractType) ? null : ltvBps(loan.outstandingCents, row.tradeCents),
    changeCents: row.lastTradeCents === null ? null : row.tradeCents - row.lastTradeCents,
  }
}

export function revalue(loans: RevaluationLoan[], rows: CurrentGuideRow[]): RevaluationRow[] {
  return loans.map((loan) => ({ ...loan, match: matchLoan(loan, rows) }))
}
