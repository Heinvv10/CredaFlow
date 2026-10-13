import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatZAR } from "@/lib/utils"
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
            <dd className="font-semibold text-[var(--cf-text)]">{formatZAR(cents as number)}</dd>
          </div>
        ))}
      </dl>
      <div className="max-h-[28rem] overflow-y-auto">
        <Table>
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
                <TableCell>{row.dueDate}</TableCell>
                <TableCell className="text-right">{row.weight}</TableCell>
                <TableCell className="text-right">{formatZAR(row.openingBalanceCents)}</TableCell>
                <TableCell className="text-right">{formatZAR(row.interestCents)}</TableCell>
                <TableCell className="text-right">{formatZAR(row.principalCents)}</TableCell>
                <TableCell className="text-right">{row.balloonCents ? formatZAR(row.balloonCents) : "—"}</TableCell>
                <TableCell className="text-right font-medium">{formatZAR(row.totalCents)}</TableCell>
                <TableCell className="text-right">{formatZAR(row.closingBalanceCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
