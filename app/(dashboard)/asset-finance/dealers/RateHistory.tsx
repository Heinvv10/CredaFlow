import { formatDate } from "@/lib/utils"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { bpsPercent } from "@/lib/dealer/staff-labels"

export interface RateRow {
  id: string
  effectiveFrom: string
  bps: number
  flatCents: number
  createdAt: Date
  createdBy: { name: string | null; email: string }
}

/** A rate history, newest first; the row in force today is marked. */
export function RateHistory({ rows, today }: { rows: RateRow[]; today: string }) {
  if (rows.length === 0) return <p className="text-sm text-[var(--cf-text-muted)]">No rate set.</p>
  const current = rows.find((r) => r.effectiveFrom <= today)?.id
  return (
    <ul className="space-y-1 text-sm">
      {rows.map((r) => (
        <li key={r.id} className="text-[var(--cf-text)]">
          From {formatIsoDate(r.effectiveFrom)}: {bpsPercent(r.bps)} + {formatMoney(r.flatCents)}
          {r.id === current && <span className="ml-2 text-xs font-semibold text-[var(--cf-success)]">in force</span>}
          {r.effectiveFrom > today && <span className="ml-2 text-xs text-[var(--cf-text-muted)]">future</span>}
          <span className="ml-2 text-xs text-[var(--cf-text-muted)]">set by {r.createdBy.name ?? r.createdBy.email} on {formatDate(r.createdAt)}</span>
        </li>
      ))}
    </ul>
  )
}
