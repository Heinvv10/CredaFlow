import type { Solved } from "./deal-structure"
import { solveDealStructure } from "./deal-structure"
import type { AssetPrice, ResolvedRate } from "./deal-structure"
import type { StructureTerms } from "./deal-input"

/**
 * NCA asset pricing keeps the initiation fee interest-free and charges the
 * monthly service fee as a fee on each scheduled payment. The asset engine
 * still determines the weighted capital/interest path; statutory fees never
 * enter its interest-bearing opening balance.
 */
export function solveNcaDealStructure(
  asset: AssetPrice,
  terms: StructureTerms,
  rate: ResolvedRate,
  startDate?: string,
  monthlyServiceFeeCents = 6_000,
): Solved {
  const solved = solveDealStructure(asset, { ...terms, financedFeesCents: 0 }, rate, startDate)
  if (!solved.ok) return solved
  const initiationFeeCents = terms.financedFeesCents
  const rows = solved.result.rows.map((row, index) => {
    const feesCents = monthlyServiceFeeCents + (index === 0 ? initiationFeeCents : 0)
    return { ...row, feesCents, totalCents: row.totalCents + feesCents }
  })
  return {
    ...solved,
    result: {
      ...solved.result,
      baseInstalmentCents: solved.result.baseInstalmentCents + monthlyServiceFeeCents,
      rows,
      totalPayableCents: rows.reduce((sum, row) => sum + row.totalCents, 0),
    },
  }
}
