import { StatusPill } from "@/components/app-shell/StatusPill"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollTable } from "@/components/asset-finance/ScrollTable"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import type { PortalLeaseRental } from "@/lib/asset-finance/portal-lease"
import type { PortalRentalState } from "@/lib/asset-finance/portal-lease-view"
import { leaseApi } from "./lease-action"

const STATE: Record<PortalRentalState, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  PAID: { label: "Paid", tone: "success" },
  PARTIAL: { label: "Partly paid", tone: "warning" },
  OVERDUE: { label: "Overdue", tone: "danger" },
  PENDING: { label: "Not yet due", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
}

/** The lease's rentals, one row a period, each with its tax invoice once issued. */
export function LeaseRentalsTable({ loanId, rentals }: { loanId: string; rentals: PortalLeaseRental[] }) {
  if (rentals.length === 0) return <p className="text-sm text-[var(--cf-text-muted)]">No rentals have been scheduled.</p>
  return (
    <ScrollTable maxHeight="max-h-[32rem]">
      <TableHeader>
        <TableRow>
          <TableHead>Period</TableHead>
          <TableHead>Due</TableHead>
          <TableHead className="text-right">Rental</TableHead>
          <TableHead className="text-right">Maintenance</TableHead>
          <TableHead className="text-right">VAT</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead className="text-right">Paid</TableHead>
          <TableHead className="text-right">Outstanding</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Tax invoice</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rentals.map((r) => (
          <TableRow key={r.id}>
            <TableCell>{r.periodNo}</TableCell>
            <TableCell>{formatIsoDate(r.dueDate)}</TableCell>
            <TableCell className="text-right">{formatMoney(r.rentalExclVatCents)}</TableCell>
            <TableCell className="text-right">{formatMoney(r.maintenanceExclVatCents)}</TableCell>
            <TableCell className="text-right">{formatMoney(r.vatCents)}</TableCell>
            <TableCell className="text-right font-medium">{formatMoney(r.totalCents)}</TableCell>
            <TableCell className="text-right">{formatMoney(r.paidCents)}</TableCell>
            <TableCell className="text-right">{formatMoney(r.outstandingCents)}</TableCell>
            <TableCell><StatusPill tone={STATE[r.state].tone}>{STATE[r.state].label}</StatusPill></TableCell>
            <TableCell>
              {r.invoice ? (
                <a href={`${leaseApi(loanId)}/tax-invoices/${r.invoice.id}?download=1`} className="font-medium text-[var(--cf-brand)] underline-offset-2 hover:underline">
                  {r.invoice.invoiceNumber}
                </a>
              ) : <span className="text-[var(--cf-text-muted)]">Not yet issued</span>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </ScrollTable>
  )
}
