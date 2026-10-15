import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollTable } from "@/components/asset-finance/ScrollTable"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { statusLabel } from "@/lib/asset-finance/labels"
import type { RentalRow } from "./lease-staff-data"

// The lease's rentals, one per period, with the tax invoice each one billed.
// Server component: no hooks.

const link = "text-[var(--cf-brand)] underline-offset-2 hover:underline"

function rentalStatus(r: RentalRow, today: string): { tone: "neutral" | "success" | "warning" | "danger" | "info"; label: string } {
  if (r.cancelled) return { tone: "neutral", label: "Cancelled" }
  if (r.scheduleStatus === "PAID") return { tone: "success", label: "Paid" }
  if (r.scheduleStatus === "OVERDUE" || r.scheduleStatus === "WRITTEN_OFF") return { tone: "danger", label: statusLabel(r.scheduleStatus) }
  if (r.scheduleStatus === "PARTIAL") return { tone: "warning", label: "Part paid" }
  return r.dueDate <= today ? { tone: "warning", label: "Due" } : { tone: "neutral", label: "Upcoming" }
}

export function LeaseRentalsTable({ rentals, maintenance, today }: { rentals: RentalRow[]; maintenance: boolean; today: string }) {
  const live = rentals.filter((r) => !r.cancelled)
  const invoiced = rentals.filter((r) => r.invoice !== null).length
  return (
    <DataPanel
      title="Rentals"
      description={`${live.length} rental${live.length === 1 ? "" : "s"} · ${invoiced} invoiced. Each rental is invoiced on its due date, or when a receipt reaches it.`}
      density="loose"
    >
      {rentals.length === 0 ? (
        <p className="text-sm text-[var(--cf-text-muted)]">No rentals are booked on this lease.</p>
      ) : (
        <ScrollTable>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Due</TableHead>
              <TableHead className="text-right">Rental ex VAT</TableHead>
              {maintenance && <TableHead className="text-right">Maintenance ex VAT</TableHead>}
              <TableHead className="text-right">VAT</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tax invoice</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rentals.map((r) => {
              const status = rentalStatus(r, today)
              return (
                <TableRow key={r.periodNo}>
                  <TableCell>{r.periodNo}</TableCell>
                  <TableCell>{formatIsoDate(r.dueDate)}</TableCell>
                  <TableCell className="text-right">{formatMoney(r.rentalExclVatCents)}</TableCell>
                  {maintenance && <TableCell className="text-right">{formatMoney(r.maintenanceExclVatCents)}</TableCell>}
                  <TableCell className="text-right">{formatMoney(r.vatCents)}</TableCell>
                  <TableCell className="text-right">{formatMoney(r.totalCents)}</TableCell>
                  <TableCell><StatusPill tone={status.tone}>{status.label}</StatusPill></TableCell>
                  <TableCell>
                    {r.invoice ? (
                      <>
                        <a className={link} href={`/api/asset-finance/tax-invoices/${r.invoice.id}`} target="_blank" rel="noopener noreferrer">{r.invoice.number}</a>
                        {" · "}
                        <a className={link} href={`/api/asset-finance/tax-invoices/${r.invoice.id}?download=1`}>Download</a>
                      </>
                    ) : (
                      <span className="text-[var(--cf-text-muted)]">{r.cancelled ? "—" : "Not yet invoiced"}</span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </ScrollTable>
      )}
    </DataPanel>
  )
}
