import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollTable } from "@/components/asset-finance/ScrollTable"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import type { ScheduleRow } from "@/lib/asset-finance/types"

// A solved deal schedule (lib/asset-finance/structure.ts). No hooks, so the
// server deal page and the client create form both render it.

export function ScheduleTable(props: {
  rows: ScheduleRow[]
  baseInstalmentCents: number
  totalInterestCents: number
  totalPayableCents: number
  financedAmountCents: number
}) {
  const capitalises = props.rows.some((row) => row.principalCents < 0)
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        {[
          ["Financed amount", props.financedAmountCents],
          ["Base instalment", props.baseInstalmentCents],
          ["Total interest", props.totalInterestCents],
          ["Total payable", props.totalPayableCents],
        ].map(([label, cents]) => (
          <div key={label}>
            <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
            <dd className="whitespace-nowrap font-semibold text-[var(--cf-text)]">{formatMoney(cents as number)}</dd>
          </div>
        ))}
      </dl>
      {capitalises && (
        <p className="text-xs text-[var(--cf-text-muted)]">
          A negative principal is interest the payment does not cover: it is capitalised (added to the balance) and repaid as principal later.
        </p>
      )}
      <ScrollTable>
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Due</TableHead>
            <TableHead className="text-right">Weight</TableHead>
            <TableHead className="text-right">Opening</TableHead>
            <TableHead className="text-right">Interest</TableHead>
            <TableHead className="text-right">Principal</TableHead>
            <TableHead className="text-right">Balloon</TableHead>
            <TableHead className="text-right">Payment</TableHead>
            <TableHead className="text-right">Closing</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.rows.map((row) => (
            <TableRow key={row.index}>
              <TableCell>{row.index + 1}</TableCell>
              <TableCell>{formatIsoDate(row.dueDate)}</TableCell>
              <TableCell className="text-right">{row.weight}</TableCell>
              <TableCell className="text-right">{formatMoney(row.openingBalanceCents)}</TableCell>
              <TableCell className="text-right">{formatMoney(row.interestCents)}</TableCell>
              <TableCell className="text-right">{formatMoney(row.principalCents)}</TableCell>
              <TableCell className="text-right">{row.balloonCents ? formatMoney(row.balloonCents) : "—"}</TableCell>
              <TableCell className="text-right font-medium">{formatMoney(row.totalCents)}</TableCell>
              <TableCell className="text-right">{formatMoney(row.closingBalanceCents)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </ScrollTable>
    </div>
  )
}
