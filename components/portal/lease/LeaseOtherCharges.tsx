import { StatusPill } from "@/components/app-shell/StatusPill"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollTable } from "@/components/asset-finance/ScrollTable"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import type { PortalLeaseView } from "@/lib/asset-finance/portal-lease"
import { leaseApi } from "./lease-action"
import { RENTAL_STATE } from "./LeaseRentalsTable"

const KIND_LABEL = { END_OF_TERM: "End-of-term invoice", TERMINATION: "Early-termination invoice" } as const

/**
 * What the lease owes besides its rentals: the end-of-term and early-termination
 * invoices (each with its tax invoice) and the default charges owed today.
 * The page shows it only when there is something to list.
 */
export function LeaseOtherCharges({ loanId, charges, defaultCharges }: {
  loanId: string
  charges: PortalLeaseView["otherCharges"]
  defaultCharges: PortalLeaseView["defaultCharges"]
}) {
  return (
    <div className="space-y-3 text-sm">
      {charges.length > 0 && (
        <ScrollTable maxHeight="max-h-[20rem]">
          <TableHeader>
            <TableRow>
              <TableHead>Charge</TableHead>
              <TableHead>Due</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tax invoice</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {charges.map((c) => (
              <TableRow key={c.id}>
                <TableCell>{KIND_LABEL[c.kind]}</TableCell>
                <TableCell>{formatIsoDate(c.dueDate)}</TableCell>
                <TableCell className="text-right font-medium">{formatMoney(c.totalCents)}</TableCell>
                <TableCell className="text-right">{formatMoney(c.paidCents)}</TableCell>
                <TableCell className="text-right">{formatMoney(c.outstandingCents)}</TableCell>
                <TableCell><StatusPill tone={RENTAL_STATE[c.state].tone}>{RENTAL_STATE[c.state].label}</StatusPill></TableCell>
                <TableCell>
                  {c.invoice ? (
                    <a href={`${leaseApi(loanId)}/tax-invoices/${c.invoice.id}?download=1`} className="font-medium text-[var(--cf-brand)] underline-offset-2 hover:underline">
                      {c.invoice.invoiceNumber}
                    </a>
                  ) : <span className="text-[var(--cf-text-muted)]">Not yet issued</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ScrollTable>
      )}
      {defaultCharges.outstandingCents > 0 && (
        <div>
          <p className="text-[var(--cf-text)]">
            Default charges owed now: <span className="font-semibold">{formatMoney(defaultCharges.outstandingCents)}</span>
          </p>
          {defaultCharges.lines.length > 0 && (
            <p className="text-xs text-[var(--cf-text-muted)]">{defaultCharges.lines.map((l) => `${l.label} ${formatMoney(l.amount)}`).join(" · ")}</p>
          )}
        </div>
      )}
    </div>
  )
}
