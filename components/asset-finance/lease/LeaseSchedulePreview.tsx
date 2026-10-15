import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollTable } from "@/components/asset-finance/ScrollTable"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { leaseYearSummary } from "@/lib/asset-finance/lease-year-summary"
import type { LeaseScheduleView } from "@/lib/asset-finance/lease-view"

// The priced lease from POST /api/asset-finance/deals/preview (`lease`): the
// rentals by year with escalation, maintenance and VAT, the totals and the
// residual (never paid by the lessee: the balance left after the last rental).
// No hooks: the create form renders it.

export function LeaseSchedulePreview(props: { lease: LeaseScheduleView; capitalCents: number; residualCents: number; maintenance: boolean }) {
  const { lease, capitalCents, residualCents, maintenance } = props
  const years = leaseYearSummary(lease.rows)
  const vatPercent = (Number(lease.vatRate) * 100).toFixed(2)
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        {[
          ["Capital (cash price ex VAT)", capitalCents],
          ["Base rental ex VAT", lease.baseRentalCents],
          ["Residual (not paid by the lessee)", residualCents],
          ["Total rentals incl. VAT", lease.totalCents],
        ].map(([label, cents]) => (
          <div key={label}>
            <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
            <dd className="whitespace-nowrap font-semibold text-[var(--cf-text)]">{formatMoney(cents as number)}</dd>
          </div>
        ))}
      </dl>
      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        {[
          ["Rentals ex VAT", lease.totalRentalExclVatCents],
          ...(maintenance ? [["Maintenance ex VAT", lease.totalMaintenanceExclVatCents]] : []),
          [`VAT at ${vatPercent}%`, lease.totalVatCents],
        ].map(([label, cents]) => (
          <div key={label}>
            <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
            <dd className="whitespace-nowrap font-semibold text-[var(--cf-text)]">{formatMoney(cents as number)}</dd>
          </div>
        ))}
      </dl>

      <div>
        <h3 className="mb-2 text-xs font-semibold text-[var(--cf-text-secondary)]">By lease year (a month, from the year&apos;s first rental)</h3>
        <ScrollTable maxHeight="max-h-72">
          <TableHeader>
            <TableRow>
              <TableHead>Year</TableHead>
              <TableHead>From</TableHead>
              <TableHead className="text-right">Rentals</TableHead>
              <TableHead className="text-right">Rental ex VAT</TableHead>
              {maintenance && <TableHead className="text-right">Maintenance ex VAT</TableHead>}
              <TableHead className="text-right">VAT</TableHead>
              <TableHead className="text-right">Total a month</TableHead>
              <TableHead className="text-right">Year total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {years.map((y) => (
              <TableRow key={y.year}>
                <TableCell>{y.year}</TableCell>
                <TableCell>{formatIsoDate(y.firstDueDate)}</TableCell>
                <TableCell className="text-right">{y.rentals}</TableCell>
                <TableCell className="text-right">{formatMoney(y.rentalExclVatCents)}</TableCell>
                {maintenance && <TableCell className="text-right">{formatMoney(y.maintenanceExclVatCents)}</TableCell>}
                <TableCell className="text-right">{formatMoney(y.vatCents)}</TableCell>
                <TableCell className="text-right">{formatMoney(y.totalCents)}</TableCell>
                <TableCell className="text-right">{formatMoney(y.yearTotalCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ScrollTable>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold text-[var(--cf-text-secondary)]">Every rental</h3>
        <ScrollTable>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Due</TableHead>
              <TableHead className="text-right">Rental ex VAT</TableHead>
              {maintenance && <TableHead className="text-right">Maintenance ex VAT</TableHead>}
              <TableHead className="text-right">VAT</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lease.rows.map((r) => (
              <TableRow key={r.periodNo}>
                <TableCell>{r.periodNo}</TableCell>
                <TableCell>{formatIsoDate(r.dueDate)}</TableCell>
                <TableCell className="text-right">{formatMoney(r.rentalExclVatCents)}</TableCell>
                {maintenance && <TableCell className="text-right">{formatMoney(r.maintenanceExclVatCents)}</TableCell>}
                <TableCell className="text-right">{formatMoney(r.vatCents)}</TableCell>
                <TableCell className="text-right">{formatMoney(r.totalCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ScrollTable>
      </div>
    </div>
  )
}
