/**
 * The book revaluation (docs/asset-finance/SLICE5.md part C, deviation 5):
 * each live asset-finance loan's asset against the current guides. It reads
 * and never writes; a dated GUIDE valuation is recorded on the deal or asset
 * page. The loader is ./revaluation-store.ts.
 */
import type { ContractType } from "@prisma/client"
import { guideRowKey } from "./csv"
import { ltvBps } from "./ltv"

export interface CurrentGuideRow {
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
}

export interface RevaluationLoan {
  loanId: string
  reference: string
  contractType: ContractType
  outstandingCents: number
  asset: { id: string; make: string; model: string; year: number; serialNumber: string }
  /** The asset's latest GUIDE valuation: the guide it read and the variant chosen then. */
  lastGuide: { guideName: string; variant: string; tradeCents: number } | null
}

export type RevaluationMatch =
  | {
      kind: "matched"
      /** recorded_variant: the variant of the last GUIDE valuation, in the guide of that name; only_row: the one row that matches. */
      basis: "recorded_variant" | "only_row"
      row: CurrentGuideRow
      /** Outstanding ÷ trade; null for a lease (its balance is rentals, not capital). */
      ltvBps: number | null
      /** Trade now less trade at the last GUIDE valuation. */
      changeCents: number | null
    }
  | { kind: "ambiguous"; count: number }
  | { kind: "none" }

export type RevaluationRow = RevaluationLoan & { match: RevaluationMatch }

const LEASES: readonly ContractType[] = ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"]
const norm = (s: string) => s.trim().toLowerCase()

function matchLoan(loan: RevaluationLoan, rows: CurrentGuideRow[]): RevaluationMatch {
  const assetKey = guideRowKey({ make: norm(loan.asset.make), model: norm(loan.asset.model), year: loan.asset.year, variant: "" })
  const candidates = rows.filter((r) => guideRowKey({ make: norm(r.make), model: norm(r.model), year: r.year, variant: "" }) === assetKey)
  const last = loan.lastGuide
  const recorded = last
    ? candidates.find((r) => norm(r.guideName) === norm(last.guideName) && norm(r.variant) === norm(last.variant))
    : undefined
  const row = recorded ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (!row) return candidates.length > 1 ? { kind: "ambiguous", count: candidates.length } : { kind: "none" }
  return {
    kind: "matched",
    basis: recorded ? "recorded_variant" : "only_row",
    row,
    ltvBps: LEASES.includes(loan.contractType) ? null : ltvBps(loan.outstandingCents, row.tradeCents),
    changeCents: last ? row.tradeCents - last.tradeCents : null,
  }
}

export function revalue(loans: RevaluationLoan[], rows: CurrentGuideRow[]): RevaluationRow[] {
  return loans.map((loan) => ({ ...loan, match: matchLoan(loan, rows) }))
}
