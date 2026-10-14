import { StatusPill } from "@/components/app-shell/StatusPill"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollTable } from "@/components/asset-finance/ScrollTable"
import { formatDate } from "@/lib/utils"
import { formatMoney } from "@/lib/asset-finance/format"
import type { PortalScheduleRow, PortalScheduleState } from "@/lib/asset-finance/portal-contract"

// A booked contract's full repayment schedule, as the portal shows it. A skip
// row (nothing due) carries the note that its interest is capitalised: it is
// added to the balance and repaid by later instalments
// (lib/asset-finance/schedule-records.ts, CAPITALISED INTEREST).

const STATE: Record<PortalScheduleState, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  PAID: { label: "Paid", tone: "success" },
  PARTIAL: { label: "Partly paid", tone: "warning" },
  OVERDUE: { label: "Overdue", tone: "danger" },
  PENDING: { label: "Pending", tone: "neutral" },
  SKIP: { label: "No payment due", tone: "info" },
}

export function PortalContractSchedule({ rows }: { rows: PortalScheduleRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-[var(--cf-text-muted)]">No schedule recorded.</p>
  return (
    <ScrollTable maxHeight="max-h-[32rem]">
      <TableHeader>
        <TableRow>
          <TableHead>No.</TableHead>
          <TableHead>Due</TableHead>
          <TableHead className="text-right">Amount due</TableHead>
          <TableHead className="text-right">Paid</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.installmentNo}>
            <TableCell>{r.installmentNo}</TableCell>
            <TableCell>{formatDate(r.dueDate)}</TableCell>
            <TableCell className="text-right">
              {formatMoney(r.totalDueCents)}
              {r.balloonCents > 0 && (
                <span className="block text-xs text-[var(--cf-text-muted)]">incl. balloon {formatMoney(r.balloonCents)}</span>
              )}
            </TableCell>
            <TableCell className="text-right">{formatMoney(r.paidCents)}</TableCell>
            <TableCell>
              <StatusPill tone={STATE[r.state].tone}>{STATE[r.state].label}</StatusPill>
              {r.state === "SKIP" && (
                <span className="mt-1 block min-w-[14rem] whitespace-normal text-xs text-[var(--cf-text-muted)]">
                  Interest for this period is capitalised and repaid in later instalments.
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </ScrollTable>
  )
}
