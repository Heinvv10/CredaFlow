import { DataPanel } from "@/components/app-shell/DataPanel"
import { isoOfDbDate } from "@/lib/asset-finance/dates"

interface TermsRow {
  sequence: number
  interestRatePm: number
  rateBasis: string | null
  rateMarginPa: number | null
  referenceRate: number | null
  referenceEffectiveDate: Date | null
  balloonCents: number
  createdAt: Date
}

const pct = (decimal: number) => `${Math.round(decimal * 1_000_000) / 10_000}%`

/** A variable-rate loan's rates, oldest first: each row is what the terms table holds. Shown only for a loan on a reference rate. */
export function LoanRateHistory({ terms }: { terms: TermsRow[] }) {
  if (!terms.some((row) => row.rateBasis !== null)) return null
  return (
    <DataPanel title="Rate history" description="Follows the lender's approved reference rate. Each change regenerates the instalments still to come." density="compact">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-[var(--cf-text-muted)]"><th className="py-1">Terms</th><th>From</th><th>Reference</th><th>Margin</th><th className="text-right">Rate a month</th></tr></thead>
        <tbody>
          {terms.map((row) => (
            <tr key={row.sequence} className="border-t border-[var(--cf-border-subtle)]">
              <td className="py-1">{row.sequence}</td>
              <td>{row.referenceEffectiveDate ? isoOfDbDate(row.referenceEffectiveDate) : "—"}</td>
              <td>{row.referenceRate !== null ? `${row.rateBasis} ${pct(row.referenceRate)}` : "—"}</td>
              <td>{row.rateMarginPa !== null ? pct(row.rateMarginPa) : "—"}</td>
              <td className="text-right">{pct(row.interestRatePm)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </DataPanel>
  )
}
